import { Prisma } from '@prisma/client';
import { audit, db } from '../db';
import { blocked, type Flag } from '../checks';
import { env, testMode } from '../env';
import { allocateSlots, dayKey, nextSlot, planProblems, type SchedulePlan } from '../schedule';
import { mail, MailError } from '../mail';
import { tooNewFor } from './account';
import { checkDraft, loadForDraft } from './drafting';

/** An error whose text is meant for staff. */
export class UserError extends Error {}

type Tx = Prisma.TransactionClient;

export const planOf = (c: SchedulePlan): SchedulePlan => ({
  startDate: c.startDate,
  windowStart: c.windowStart,
  windowEnd: c.windowEnd,
  timezone: c.timezone,
  minPerDay: c.minPerDay,
  maxPerDay: c.maxPerDay,
  weekdays: c.weekdays,
});

/** The plan with the slow start of a LIVE campaign: counted from the student's first real email, or from the first possible day. */
export async function planWithStart(tx: Tx, c: SchedulePlan & { studentId: string; live: boolean; slowStart: boolean }, now = new Date()): Promise<SchedulePlan> {
  const plan = planOf(c);
  if (testMode(c.live) || !c.slowStart) return plan;
  const first = await tx.email.findFirst({ where: { studentId: c.studentId, sandboxed: false, sentAt: { not: null } }, orderBy: { sentAt: 'asc' }, select: { sentAt: true } });
  const today = dayKey(now, plan.timezone);
  return { ...plan, slowFrom: first ? dayKey(first.sentAt!, plan.timezone) : plan.startDate > today ? plan.startDate : today };
}

/** Below this the AI has nothing to write from. */
export const MIN_ABOUT = 200;

export interface NewCampaign extends SchedulePlan {
  studentId: string;
  listId: string;
  cvId: string;
  name: string;
  intake?: string;
  instructions?: string;
  autoSchedule?: boolean;
  /** Emails of earlier campaigns that were not sent yet move into this one and are written again */
  replace?: boolean;
  /** Real sending to the addresses in the list */
  live?: boolean;
  slowStart?: boolean;
}

export async function createCampaign(input: NewCampaign, staff: string) {
  const problems = planProblems(input);
  if (problems.length) throw new UserError(problems.join(' '));
  const [student, list, cv] = await Promise.all([
    db.student.findUnique({ where: { id: input.studentId }, include: { profiles: { orderBy: { version: 'desc' }, take: 1 } } }),
    db.professorList.findFirst({ where: { id: input.listId, studentId: input.studentId, status: 'IMPORTED' }, include: { professors: { orderBy: { rowNumber: 'asc' } } } }),
    db.cv.findFirst({ where: { id: input.cvId, studentId: input.studentId }, select: { id: true } }),
  ]);
  if (!student) throw new UserError('Student not found.');
  if (!list) throw new UserError('Choose an imported professor list of this student.');
  if (!cv) throw new UserError('Choose a CV of this student.');
  const profile = student.profiles[0];
  if (profile && (profile.status === 'PENDING' || profile.status === 'RUNNING')) throw new UserError('The Profile is still being read. Wait a moment.');
  const about = [profile?.status === 'READY' ? profile.brief : '', student.notes].filter(Boolean).join('\n').trim();
  if (about.length < MIN_ABOUT) throw new UserError(`Upload the student’s Profile (PDF) first, or write more about the student (at least ${MIN_ABOUT} characters, now ${about.length}): degree and result, thesis, experience, skills, papers, test scores, research interest. With too little the AI invents, and every email has to be corrected, which is slow.`);
  if (!student.phone?.trim()) throw new UserError('Add the student’s phone number first: it is part of every email.');
  if (!student.isDemo && !student.consentAt) throw new UserError('Record the student’s consent first.');

  if (input.live) {
    mustBeReal(student);
    await mustBeOldEnough(student.id, list.professors.map((p) => p.email));
  }

  const c = await db.$transaction(async (tx) => {
    const c = await tx.campaign.create({
      data: { studentId: student.id, listId: list.id, cvId: cv.id, name: input.name || list.fileName, intake: input.intake || null, instructions: input.instructions || null, autoSchedule: input.autoSchedule ?? true, live: input.live ?? false, slowStart: input.slowStart ?? true, createdBy: staff, ...planOf(input) },
    });
    // emails that were cancelled before they were sent do not use the professor up
    await tx.email.deleteMany({ where: { studentId: student.id, status: 'CANCELLED', sentAt: null, gmailDraftId: null, claimToken: null, toEmail: { in: list.professors.map((p) => p.email) }, NOT: { error: { startsWith: 'Not sent: this professor already wrote' } } } });
    // emails that only went out in test mode never reached the professor: they do not use the address up
    const tests = await tx.email.findMany({ where: { studentId: student.id, toEmail: { in: list.professors.map((p) => p.email) }, sandboxed: true, status: { in: ['SENT', 'BOUNCED'] } }, select: { id: true } });
    if (tests.length) {
      const ids = tests.map((t) => t.id);
      await tx.thread.updateMany({ where: { emailId: { in: ids } }, data: { emailId: null } });
      await tx.email.deleteMany({ where: { id: { in: ids } } });
    }
    const byEmail = new Map(list.professors.map((p) => [p.email, p.id]));
    let moved = 0;
    if (input.replace) {
      const old = await tx.email.findMany({
        where: { studentId: student.id, toEmail: { in: [...byEmail.keys()] }, sentAt: null, status: { in: ['PENDING', 'GENERATING', 'GEN_FAILED', 'DRAFT', 'SCHEDULED'] }, OR: [{ claimToken: null }, { status: 'GENERATING' }, { claimedAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
        select: { id: true, status: true, toEmail: true, claimToken: true, campaignId: true },
      });
      for (const e of old) {
        // the Gmail draft stays with the email and is updated later, so there is never a second draft
        const done = await tx.email.updateMany({
          where: { id: e.id, status: e.status, claimToken: e.claimToken },
          data: { campaignId: c.id, professorId: byEmail.get(e.toEmail)!, status: 'PENDING', subject: '', body: '', fit: null, fitNote: null, flags: [], attempts: 0, claimToken: null, notBefore: null, scheduledFor: null, sendNow: false, step: null, error: null, draftedAt: null, contentVersion: { increment: 1 } },
        });
        moved += done.count;
      }
      await tx.campaign.updateMany({ where: { id: { in: [...new Set(old.map((e) => e.campaignId))] }, status: { in: ['GENERATING', 'REVIEW', 'ACTIVE'] }, emails: { none: {} } }, data: { status: 'CANCELLED' } });
    }
    const made = await tx.email.createMany({
      data: list.professors.map((p) => ({ campaignId: c.id, studentId: student.id, professorId: p.id, toEmail: p.email })),
      skipDuplicates: true, // this student already has an email to that address
    });
    const total = made.count + moved;
    if (!total) {
      const where = await tx.email.groupBy({ by: ['campaignId', 'status'], where: { studentId: student.id, toEmail: { in: [...byEmail.keys()] } }, _count: { _all: true } });
      const sent = where.filter((w) => ['SENT', 'BOUNCED', 'SENDING', 'UNCERTAIN'].includes(w.status)).reduce((n, w) => n + w._count._all, 0);
      const open = where.filter((w) => ['PENDING', 'GENERATING', 'GEN_FAILED', 'DRAFT', 'SCHEDULED'].includes(w.status)).reduce((n, w) => n + w._count._all, 0);
      const names = await tx.campaign.findMany({ where: { id: { in: where.map((w) => w.campaignId) } }, select: { name: true } });
      throw new UserError(`Every professor in this list already has an email from this student (${[sent && `${sent} sent`, open && `${open} not sent yet`].filter(Boolean).join(', ') || 'being cancelled, try again in a minute'}, in: ${[...new Set(names.map((x) => x.name))].join(', ')}).${open ? ' Tick \u201cReplace emails not sent yet\u201d to write them again in this campaign.' : ''}`);
    }
    return tx.campaign.update({ where: { id: c.id }, data: { skipped: list.professors.length - total } });
  });
  await audit(staff, 'campaign.created', 'Campaign', c.id);
  return c;
}

const TAKEN = ['SCHEDULED', 'SENDING', 'SENT', 'BOUNCED', 'UNCERTAIN'] as const;

/** Emails per day this student already has, leaving out `except`. The student's row must be locked. */
async function usedDays(tx: Tx, studentId: string, tz: string, except: string[]) {
  const rows = await tx.email.findMany({ where: { studentId, status: { in: [...TAKEN] }, id: { notIn: except } }, select: { scheduledFor: true, sentAt: true } });
  const used = new Map<string, number>();
  for (const r of rows) {
    const d = r.sentAt ?? r.scheduledFor;
    if (d) used.set(dayKey(d, tz), (used.get(dayKey(d, tz)) ?? 0) + 1);
  }
  return used;
}

const lockStudent = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${id} FOR UPDATE`;

async function setSlots(tx: Tx, ids: string[], slots: Date[], from: 'DRAFT' | 'SCHEDULED') {
  return tx.$executeRaw`
    UPDATE "Email" e SET status = 'SCHEDULED', "scheduledFor" = s.at::timestamptz, "notBefore" = NULL, "sendNow" = false, attempts = 0, error = NULL, "updatedAt" = now()
    FROM unnest(${ids}::text[], ${slots.map((d) => d.toISOString())}::text[]) AS s(id, at)
    WHERE e.id = s.id AND e.status = ${from}::"EmailStatus"`;
}

const RANK = ['strong', 'some', 'unknown', 'weak'];
const rank = (fit: string | null) => (RANK.indexOf(fit ?? '') + RANK.length) % RANK.length;

/** Approves every draft without a blocking problem and gives each one a send time. Can be repeated. */
export async function approveCampaign(campaignId: string, staff: string, onlyEmailId?: string) {
  const n = await db.$transaction(
    async (tx) => {
      const c = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { student: { include: { mailbox: true } } } });
      await lockStudent(tx, c.studentId);
      if (c.student.mailbox?.status !== 'CONNECTED') throw new UserError('Connect the student’s Gmail first.');
      const drafts = (
        await tx.email.findMany({ where: { campaignId, status: 'DRAFT', ...(onlyEmailId ? { id: onlyEmailId } : {}) }, orderBy: { professor: { rowNumber: 'asc' } }, select: { id: true, flags: true, fit: true } })
      )
        .filter((d) => !blocked(d.flags))
        .sort((a, b) => rank(a.fit) - rank(b.fit)); // best match first; the rank itself is never shown
      if (!drafts.length) throw new UserError('There is nothing ready to approve. Fix the blocked emails first.');
      const ids = drafts.map((d) => d.id);
      const plan = await planWithStart(tx, c);
      const slots = allocateSlots(ids.length, plan, { now: new Date(), used: await usedDays(tx, c.studentId, c.timezone, ids) });
      const done = await setSlots(tx, ids, slots, 'DRAFT');
      if (c.status === 'CANCELLED') throw new UserError('This campaign was cancelled.');
      await tx.campaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', approvedBy: staff, approvedAt: new Date() } });
      return done;
    },
    { timeout: 60_000 },
  );
  await audit(staff, 'campaign.approved', 'Campaign', campaignId, { scheduled: n });
  return n;
}

/** Gives one finished email the next free send time. False when it may not be scheduled. */
export async function scheduleOne(id: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const e = await tx.email.findUniqueOrThrow({ where: { id }, include: { campaign: true } });
    await lockStudent(tx, e.studentId);
    const c = e.campaign;
    if (c.paused || !['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status) || blocked(e.flags)) return false;
    const rows = await tx.email.findMany({ where: { studentId: e.studentId, status: { in: [...TAKEN] }, id: { not: id } }, select: { scheduledFor: true, sentAt: true } });
    const taken = rows.map((r) => r.sentAt ?? r.scheduledFor).filter((d): d is Date => !!d);
    const at = nextSlot(await planWithStart(tx, c), { now: new Date(), taken, seed: e.studentId });
    if (!(await setSlots(tx, [id], [at], 'DRAFT'))) return false;
    if (c.status !== 'ACTIVE') await tx.campaign.update({ where: { id: c.id }, data: { status: 'ACTIVE', approvedBy: `automatic, chosen by ${c.createdBy}`, approvedAt: new Date() } });
    return true;
  });
}

/** Emails that became ready later (corrected by staff, Gmail connected meanwhile) get their time too. */
export async function scheduleReady(limit = 30): Promise<number> {
  const rows = await db.email.findMany({
    where: { status: 'DRAFT', claimToken: null, campaign: { autoSchedule: true, paused: false, status: { in: ['GENERATING', 'REVIEW', 'ACTIVE'] } }, student: { mailbox: { status: 'CONNECTED' } } },
    orderBy: [{ professor: { rowNumber: 'asc' } }],
    take: 300,
    select: { id: true, flags: true },
  });
  let n = 0;
  for (const e of rows) {
    if (n >= limit) break;
    if (!blocked(e.flags) && (await scheduleOne(e.id))) n++;
  }
  return n;
}

export async function setAutoSchedule(campaignId: string, on: boolean, staff: string) {
  await db.campaign.update({ where: { id: campaignId }, data: { autoSchedule: on } });
  await audit(staff, on ? 'campaign.auto_on' : 'campaign.auto_off', 'Campaign', campaignId);
}

/** A cancelled email comes back. With automatic scheduling it gets a new time by itself. */
export async function restoreEmail(id: string, staff: string) {
  const e = await db.email.findUniqueOrThrow({ where: { id }, include: { campaign: true } });
  if (e.campaign.status === 'CANCELLED') throw new UserError('Its campaign was cancelled. Start a new campaign instead.');
  if (e.gmailDraftId) throw new UserError('Its old draft is still being removed from Gmail. Try again in a minute.');
  const done = await db.email.updateMany({ where: { id, status: 'CANCELLED', sentAt: null, gmailDraftId: null }, data: { status: e.body ? 'DRAFT' : 'PENDING', error: null, attempts: 0, notBefore: null, claimToken: null, scheduledFor: null } });
  if (!done.count) throw new UserError('Only a cancelled email can be restored.');
  if (e.campaign.status === 'COMPLETED') await db.campaign.update({ where: { id: e.campaignId }, data: { status: 'ACTIVE' } });
  await audit(staff, 'email.restored', 'Email', id);
}

/** Stops a campaign for good: nothing more is written or sent, and its drafts leave Gmail. Sent emails stay as they are. */
export async function cancelCampaign(campaignId: string, staff: string) {
  const n = await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED', paused: false, pauseReason: null } });
    await tx.email.updateMany({ where: { campaignId, status: 'GENERATING' }, data: { claimToken: null } }); // the writer's result is then ignored
    const done = await tx.email.updateMany({ where: { campaignId, status: { in: ['PENDING', 'GENERATING', 'GEN_FAILED', 'DRAFT', 'SCHEDULED'] } }, data: { status: 'CANCELLED', error: `Campaign cancelled by ${staff}`, notBefore: null, sendNow: false, step: null } });
    return done.count;
  });
  await audit(staff, 'campaign.cancelled', 'Campaign', campaignId, { n });
  return n;
}

/** New send times for scheduled emails that missed theirs. */
export async function moveToNextSlots(campaignId: string, ids: string[], now = new Date(), opts: { notToday?: boolean } = {}) {
  await db.$transaction(
    async (tx) => {
      const c = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      await lockStudent(tx, c.studentId);
      const tomorrow = dayKey(new Date(now.getTime() + 24 * 3600_000), c.timezone);
      const slots = allocateSlots(ids.length, await planWithStart(tx, c, now), { now, fill: true, used: await usedDays(tx, c.studentId, c.timezone, ids), notBefore: opts.notToday ? tomorrow : undefined });
      await setSlots(tx, ids, slots, 'SCHEDULED');
    },
    { timeout: 60_000 },
  );
}

function mustBeReal(student: { consentAt: Date | null }) {
  if (env().EMAIL_SANDBOX) throw new UserError('Real sending is switched off in the settings (EMAIL_SANDBOX=true).');
  if (!student.consentAt) throw new UserError('Real sending needs the student’s recorded consent. Tick it under Details on the student page.');
}

async function mustBeOldEnough(studentId: string, to: string[]) {
  if ((await db.mailbox.findUnique({ where: { studentId }, select: { status: true } }))?.status !== 'CONNECTED') throw new UserError('Connect the student’s Gmail first.');
  let why: string | null;
  try {
    why = await tooNewFor(studentId, to, true);
  } catch (e) {
    if (e instanceof MailError) throw new UserError('Gmail could not be asked how old this account is. Try again in a moment.');
    throw e;
  }
  if (why) throw new UserError(why);
}

/** LIVE: emails go to the real addresses. The drafts in Gmail are re-addressed either way. */
export async function setLive(campaignId: string, live: boolean, staff: string) {
  const c = await db.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { student: { include: { mailbox: true } } } });
  if (live) {
    mustBeReal(c.student);
    if (c.student.mailbox?.status !== 'CONNECTED') throw new UserError('Connect the student’s Gmail first.');
    if (!['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status)) throw new UserError('This campaign is closed.');
    const waiting = await db.email.findMany({ where: { campaignId, status: { notIn: ['SENT', 'BOUNCED', 'CANCELLED'] } }, select: { toEmail: true } });
    await mustBeOldEnough(c.studentId, waiting.map((e) => e.toEmail));
  }
  await db.$transaction([
    db.campaign.update({ where: { id: campaignId }, data: { live } }),
    db.email.updateMany({ where: { campaignId, status: { in: ['SCHEDULED', 'DRAFT'] } }, data: { contentVersion: { increment: 1 }, sendNow: false } }),
  ]);
  await audit(staff, live ? 'campaign.LIVE' : 'campaign.test_mode', 'Campaign', campaignId);
  if (live && c.slowStart && c.status === 'ACTIVE') await changeSchedule(campaignId, planOf(c), staff); // fewer a day at first
}

/** Consent withdrawn: nothing of this student is sent for real any more. */
export async function endLive(studentId: string, staff: string) {
  for (const c of await db.campaign.findMany({ where: { studentId, live: true }, select: { id: true } })) await setLive(c.id, false, staff);
}

/** New sending rules: every email not yet sent gets a new time. */
export async function changeSchedule(campaignId: string, plan: SchedulePlan, staff: string) {
  const problems = planProblems(plan);
  if (problems.length) throw new UserError(problems.join(' '));
  await db.$transaction(
    async (tx) => {
      const c = await tx.campaign.update({ where: { id: campaignId }, data: planOf(plan) });
      await lockStudent(tx, c.studentId);
      const rows = await tx.email.findMany({ where: { campaignId, status: 'SCHEDULED' }, orderBy: { scheduledFor: 'asc' }, select: { id: true } });
      const ids = rows.map((r) => r.id);
      if (ids.length) await setSlots(tx, ids, allocateSlots(ids.length, await planWithStart(tx, c), { now: new Date(), used: await usedDays(tx, c.studentId, plan.timezone, ids) }), 'SCHEDULED');
    },
    { timeout: 60_000 },
  );
  await audit(staff, 'campaign.rescheduled', 'Campaign', campaignId, { ...plan });
}

/** Slow start on or off; the send times follow. */
export async function setSlowStart(campaignId: string, on: boolean, staff: string) {
  const c = await db.campaign.update({ where: { id: campaignId }, data: { slowStart: on } });
  await audit(staff, on ? 'campaign.slow_start_on' : 'campaign.slow_start_off', 'Campaign', campaignId);
  if (c.status === 'ACTIVE' && !testMode(c.live)) await changeSchedule(campaignId, planOf(c), staff);
}

export async function setPaused(campaignId: string, paused: boolean, staff: string) {
  await db.campaign.update({ where: { id: campaignId }, data: { paused, pauseReason: paused ? `Paused by ${staff}` : null } });
  await audit(staff, paused ? 'campaign.paused' : 'campaign.resumed', 'Campaign', campaignId);
}

/** Staff edit. Allowed until sending starts; the Gmail draft is updated by the worker. */
export async function editEmail(id: string, input: { subject: string; body: string }, staff: string) {
  const e = await loadForDraft(id);
  const subject = input.subject.replace(/\s+/g, ' ').trim();
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!subject || !body) throw new UserError('Subject and text are both needed.');
  const flags: Flag[] = checkDraft(e, subject, body);
  const kept = (e.flags as unknown as Flag[]).filter((f) => f.code === 'also_contacted');
  if (e.status === 'SCHEDULED' && blocked(flags)) throw new UserError(flags.filter((f) => f.level === 'block').map((f) => f.text).join(' '));
  const done = await db.email.updateMany({
    where: { id, status: { in: ['DRAFT', 'SCHEDULED', 'GEN_FAILED'] }, contentVersion: e.contentVersion },
    data: { subject, body, flags: [...flags, ...kept] as any, contentVersion: { increment: 1 }, ...(e.status === 'GEN_FAILED' ? { status: 'DRAFT', error: null } : {}) },
  });
  if (!done.count) throw new UserError('This email changed or is being sent. Reload the page.');
  await audit(staff, 'email.edited', 'Email', id);
}

export async function rewriteEmail(id: string, staff: string) {
  const done = await db.email.updateMany({ where: { id, status: { in: ['DRAFT', 'GEN_FAILED'] } }, data: { status: 'PENDING', attempts: 0, notBefore: null, error: null, draftedAt: null } });
  if (!done.count) throw new UserError('Only an email in review can be written again.');
  await audit(staff, 'email.rewrite', 'Email', id);
}

/** Everything not sent yet goes back to the writer, for example after the writing rules changed. Gmail drafts are updated, not doubled. */
export async function rewriteAll(campaignId: string, staff: string) {
  const n = await db.$transaction(async (tx) => {
    const done = await tx.email.updateMany({
      where: { campaignId, status: { in: ['DRAFT', 'GEN_FAILED', 'SCHEDULED'] }, OR: [{ claimToken: null }, { claimedAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
      data: { status: 'PENDING', attempts: 0, notBefore: null, scheduledFor: null, sendNow: false, error: null, claimToken: null, draftedAt: null },
    });
    if (!done.count) throw new UserError('There is nothing left to write again.');
    await tx.campaign.update({ where: { id: campaignId }, data: { status: 'GENERATING' } });
    return done.count;
  });
  await audit(staff, 'campaign.rewrite_all', 'Campaign', campaignId, { n });
  return n;
}

/** Test mode only: one email leaves now instead of at its time, to the test inbox. */
export async function sendTestNow(id: string, staff: string) {
  const e = await db.email.findUniqueOrThrow({ where: { id }, select: { campaign: { select: { live: true } } } });
  if (!testMode(e.campaign.live)) throw new UserError('Only in test mode.');
  const done = await db.email.updateMany({ where: { id, status: 'SCHEDULED', claimToken: null }, data: { scheduledFor: new Date(), sendNow: true, notBefore: null } });
  if (!done.count) throw new UserError('Only a scheduled email can be sent. Try again in a minute.');
  await audit(staff, 'email.test_send', 'Email', id);
}

/** A person read a blocking problem and takes responsibility for it. */
export async function acceptFlags(id: string, staff: string) {
  const e = await db.email.findUniqueOrThrow({ where: { id } });
  const flags = (e.flags as unknown as Flag[]).map((f) => (f.level === 'block' && !['no_subject', 'subject_lines', 'placeholder'].includes(f.code) ? { ...f, level: 'warn' as const, text: `${f.text} (checked by ${staff})` } : f));
  await db.email.updateMany({ where: { id, status: 'DRAFT', contentVersion: e.contentVersion }, data: { flags: flags as any } });
  await audit(staff, 'email.flags_accepted', 'Email', id, e.flags as any);
}

async function dropGmailDraft(studentId: string, draftId: string | null): Promise<string | null> {
  if (!draftId) return null;
  try {
    await mail().deleteDraft(studentId, draftId);
    return null;
  } catch (e) {
    if (e instanceof MailError && e.kind === 'NOT_FOUND') return null;
    return 'The draft is still in Gmail: please delete it there.';
  }
}

export async function cancelEmail(id: string, staff: string) {
  const e = await db.email.findUniqueOrThrow({ where: { id } });
  const done = await db.email.updateMany({
    where: { id, status: { in: ['DRAFT', 'GEN_FAILED', 'SCHEDULED', 'UNCERTAIN'] }, OR: [{ claimToken: null }, { claimedAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
    data: { status: 'CANCELLED', error: `Cancelled by ${staff}`, claimToken: null },
  });
  if (!done.count) throw new UserError('This email is being worked on or was already sent. Try again in a minute.');
  const note = await dropGmailDraft(e.studentId, e.gmailDraftId);
  await db.email.update({ where: { id }, data: { gmailDraftId: null, ...(note ? { error: note } : {}) } });
  await audit(staff, 'email.cancelled', 'Email', id);
}

/** A person looked in Gmail and says what happened to an uncertain email. */
export async function resolveUncertain(id: string, answer: 'sent' | 'send_again', staff: string) {
  const e = await db.email.findUniqueOrThrow({ where: { id } });
  if (e.status !== 'UNCERTAIN') throw new UserError('This email is no longer uncertain.');
  if (answer === 'sent') {
    await db.email.updateMany({ where: { id, status: 'UNCERTAIN' }, data: { status: 'SENT', sentAt: e.claimedAt ?? new Date(), sentTo: e.draftTo, error: null, claimToken: null } });
  } else {
    const note = await dropGmailDraft(e.studentId, e.gmailDraftId);
    if (note) throw new UserError('Gmail could not be reached to remove the old draft. Try again.');
    await db.email.updateMany({ where: { id, status: 'UNCERTAIN' }, data: { status: 'SCHEDULED', gmailDraftId: null, gmailThreadId: null, draftVersion: null, draftTo: null, error: null, claimToken: null, attempts: 0 } });
    await moveToNextSlots(e.campaignId, [id]);
  }
  await audit(staff, `email.uncertain_${answer}`, 'Email', id);
}

export async function completeFinished() {
  await db.$executeRaw`
    UPDATE "Campaign" c SET status = 'COMPLETED'
    WHERE c.status = 'ACTIVE' AND NOT EXISTS (
      SELECT 1 FROM "Email" e WHERE e."campaignId" = c.id AND e.status IN ('PENDING','GENERATING','GEN_FAILED','DRAFT','SCHEDULED','SENDING','UNCERTAIN'))`;
}
