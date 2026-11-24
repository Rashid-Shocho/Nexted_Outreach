import crypto from 'node:crypto';
import { audit, db, outreachPaused } from '../db';
import { ownTestAddress, sandboxMissing, testMode } from '../env';
import { mail, MailError, recipientFor, type Attachment, type OutMessage } from '../mail';
import { dayKey, insideWindow, slowCap } from '../schedule';
import { tooNewFor } from './account';
import { moveToNextSlots, planOf, planWithStart } from './campaigns';

/**
 * Gmail drafts and sending.
 *
 * No duplicates: an email gets ONE Gmail draft, its id is saved before anything is sent, and sending
 * always means "send that draft". Gmail removes a draft when it is sent, so doing it twice fails
 * instead of sending twice. If we cannot tell what happened, the email becomes UNCERTAIN for a person.
 */

const CLAIM_MS = 5 * 60_000;
const LATE_MS = 10 * 60_000;
const MIN_GAP_MS = 45_000;
const MAX_ATTEMPTS = 5;
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

const load = (id: string) => db.email.findUniqueOrThrow({ where: { id }, include: { campaign: true, student: { include: { mailbox: true } } } });
type Loaded = Awaited<ReturnType<typeof load>>;

async function attachment(cvId: string, studentName: string): Promise<Attachment> {
  const cv = await db.cv.findUniqueOrThrow({ where: { id: cvId }, select: { content: true } });
  const name = studentName.replace(/[^\p{L}\p{N} .-]/gu, '').trim().replace(/\s+/g, '_');
  return { fileName: `CV_${name || 'Student'}.pdf`, mimeType: 'application/pdf', bytes: Buffer.from(cv.content) };
}

async function messageFor(e: Loaded): Promise<OutMessage & { sandboxed: boolean }> {
  const r = recipientFor(e.toEmail, e.subject, e.campaign.live);
  return { live: e.campaign.live, fromName: e.student.fullName, to: r.to, subject: r.subject, body: e.body, markup: true, attachments: [await attachment(e.campaign.cvId, e.student.fullName)], sandboxed: r.sandboxed };
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** Creates or updates the email's Gmail draft and saves its id. Throws MailError. */
async function ensureDraft(e: Loaded, claimToken: string): Promise<{ draftId: string; threadId: string; to: string; sandboxed: boolean }> {
  const want = recipientFor(e.toEmail, e.subject, e.campaign.live);
  if (e.gmailDraftId && e.gmailThreadId && e.draftVersion === e.contentVersion && same(e.draftTo, want.to) && e.sandboxed === want.sandboxed) {
    return { draftId: e.gmailDraftId, threadId: e.gmailThreadId, to: want.to, sandboxed: want.sandboxed };
  }
  // a draft the student threw away must not be changed inside the Trash, and not be sent from there
  let oldDraft = e.gmailDraftId;
  if (oldDraft && (await mail().draftRecipient(e.studentId, oldDraft)) === null) {
    const writtenAgain = e.draftedAt === null && !(e.gmailThreadId && (await mail().findSent(e.studentId, e.gmailThreadId)));
    if (!writtenAgain) throw new MailError('NOT_FOUND', 'The draft was deleted in Gmail.');
    oldDraft = null; // thrown away before staff had it written again: a new draft takes its place
  }
  const { sandboxed, ...msg } = await messageFor(e);
  const ref = oldDraft ? await mail().updateDraft(e.studentId, oldDraft, msg) : await mail().createDraft(e.studentId, msg);
  const saved = await db.email.updateMany({
    where: { id: e.id, claimToken },
    data: { gmailDraftId: ref.draftId, gmailThreadId: ref.threadId, draftVersion: e.contentVersion, draftTo: msg.to, draftedAt: new Date(), draftError: null, sandboxed },
  });
  if (!saved.count) {
    // somebody else took this email over meanwhile: do not leave a second draft behind
    if (!oldDraft) await mail().deleteDraft(e.studentId, ref.draftId).catch(() => undefined);
    throw new MailError('TRANSIENT', 'Lost the claim while preparing the draft.');
  }
  return { draftId: ref.draftId, threadId: ref.threadId, to: msg.to, sandboxed };
}

/** What a mailbox problem means for the whole mailbox. */
export async function noteMailboxError(studentId: string, err: MailError) {
  if (err.kind === 'AUTH') await db.mailbox.updateMany({ where: { studentId }, data: { status: 'RECONNECT', lastError: err.message.slice(0, 300) } });
  if (err.kind === 'RATE') await db.mailbox.updateMany({ where: { studentId }, data: { sendPausedUntil: minutes(30), lastError: err.message.slice(0, 300) } });
}

// ---------------------------------------------------------------- putting drafts into Gmail

/** Puts waiting drafts into the students' Gmail Drafts. Returns how many it handled. */
export async function pushDrafts(limit = 20): Promise<number> {
  if (sandboxMissing()) return 0;
  const token = crypto.randomUUID();
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Email" SET "claimToken" = ${token}, "claimedAt" = now()
    WHERE id IN (
      SELECT e.id FROM "Email" e
      JOIN "Campaign" c ON c.id = e."campaignId" JOIN "Mailbox" m ON m."studentId" = e."studentId"
      WHERE e.status = 'SCHEDULED' AND c.status = 'ACTIVE' AND NOT c.paused AND m.status = 'CONNECTED'
        AND (m."sendPausedUntil" IS NULL OR m."sendPausedUntil" <= now())
        AND (e."gmailDraftId" IS NULL OR e."draftVersion" IS DISTINCT FROM e."contentVersion")
        AND (e."claimToken" IS NULL OR e."claimedAt" < now() - interval '5 minutes')
        AND (e."notBefore" IS NULL OR e."notBefore" <= now())
        AND e."scheduledFor" > now() + interval '1 minute'
      ORDER BY e."scheduledFor" LIMIT ${limit} FOR UPDATE OF e SKIP LOCKED)
    RETURNING id`;
  await Promise.all(
    chunk(rows, 5).map(async (part) => {
      for (const { id } of part) {
        await putDraft(id, token);
      }
    }),
  );
  return rows.length;
}

/** One email's draft, right after it was written. */
export async function pushOne(id: string) {
  if (sandboxMissing()) return;
  const token = crypto.randomUUID();
  const got = await db.email.updateMany({ where: { id, status: 'SCHEDULED', claimToken: null, campaign: { status: 'ACTIVE', paused: false } }, data: { claimToken: token, claimedAt: new Date(), step: 'Putting the draft into Gmail' } });
  if (got.count) await putDraft(id, token);
}

async function putDraft(id: string, token: string) {
  const e = await load(id);
  try {
    await ensureDraft(e, token);
    await db.email.updateMany({ where: { id, claimToken: token }, data: { claimToken: null, step: null, attempts: 0 } });
  } catch (err: any) {
    if (err instanceof MailError) await noteMailboxError(e.studentId, err);
    // a missing draft is settled at send time, where Gmail is asked whether it was sent
    await db.email.updateMany({
      where: { id, claimToken: token },
      data: { claimToken: null, step: null, attempts: { increment: 1 }, notBefore: minutes(Math.min(60, 2 ** (e.attempts + 1))), draftError: String(err?.message ?? err).slice(0, 300) },
    });
  }
}

/** Takes the drafts of cancelled emails out of the students' Gmail. */
export async function cleanUpCancelled(limit = 20): Promise<number> {
  const rows = await db.email.findMany({
    where: { status: 'CANCELLED', gmailDraftId: { not: null }, student: { mailbox: { status: 'CONNECTED' } }, OR: [{ claimToken: null }, { claimedAt: { lt: new Date(Date.now() - CLAIM_MS) } }], AND: [{ OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }] }] },
    take: limit,
    select: { id: true, studentId: true, gmailDraftId: true, gmailThreadId: true },
  });
  for (const e of rows) {
    try {
      try {
        await mail().deleteDraft(e.studentId, e.gmailDraftId!);
      } catch (err) {
        if (!(err instanceof MailError) || err.kind !== 'NOT_FOUND') throw err;
        // gone already: was it sent by hand?
        const sent = e.gmailThreadId ? await mail().findSent(e.studentId, e.gmailThreadId) : null;
        if (sent) {
          await db.email.updateMany({ where: { id: e.id, status: 'CANCELLED' }, data: { status: 'SENT', sentAt: sent.sentAt ?? new Date(), gmailMessageId: sent.messageId, gmailDraftId: null } });
          continue;
        }
      }
      await db.email.updateMany({ where: { id: e.id, status: 'CANCELLED', gmailDraftId: e.gmailDraftId }, data: { gmailDraftId: null, gmailThreadId: null, draftVersion: null, draftTo: null, claimToken: null, scheduledFor: null } });
    } catch (err) {
      if (err instanceof MailError) await noteMailboxError(e.studentId, err);
      await db.email.updateMany({ where: { id: e.id }, data: { notBefore: minutes(2) } });
    }
  }
  return rows.length;
}

function chunk<T>(a: T[], groups: number): T[][] {
  const out: T[][] = Array.from({ length: Math.min(groups, a.length) }, () => []);
  a.forEach((x, i) => out[i % out.length].push(x));
  return out;
}

// ---------------------------------------------------------------- times that were missed

/** Emails that missed their moment get a new one; they are never sent in a burst. */
export async function moveLate(now = new Date()) {
  const late = await db.email.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledFor: { lt: now },
      campaign: { status: 'ACTIVE', paused: false },
      student: { mailbox: { status: 'CONNECTED' } },
      OR: [{ claimToken: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_MS) } }],
    },
    include: { campaign: true },
    orderBy: { scheduledFor: 'asc' },
    take: 2000,
  });
  const groups = new Map<string, string[]>();
  for (const e of late) {
    if (e.sendNow && testMode(e.campaign.live)) continue; // a test send does not follow the window
    const tooLate = now.getTime() - e.scheduledFor!.getTime() > LATE_MS;
    if (tooLate || !insideWindow(now, planOf(e.campaign))) groups.set(e.campaignId, [...(groups.get(e.campaignId) ?? []), e.id]);
  }
  for (const [campaignId, ids] of groups) await moveToNextSlots(campaignId, ids, now);
}

// ---------------------------------------------------------------- sending

async function claimDue(now: Date): Promise<{ id: string; token: string } | null> {
  const token = crypto.randomUUID();
  try {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Email" SET status = 'SENDING', "claimToken" = ${token}, "claimedAt" = now(), "updatedAt" = now()
      WHERE id = (
        SELECT e.id FROM "Email" e
        JOIN "Campaign" c ON c.id = e."campaignId" JOIN "Mailbox" m ON m."studentId" = e."studentId"
        WHERE e.status = 'SCHEDULED' AND e."scheduledFor" <= ${now} AND (e."notBefore" IS NULL OR e."notBefore" <= ${now})
          AND c.status = 'ACTIVE' AND NOT c.paused AND m.status = 'CONNECTED'
          AND (m."sendPausedUntil" IS NULL OR m."sendPausedUntil" <= ${now})
          AND (e."claimToken" IS NULL OR e."claimedAt" < now() - interval '5 minutes')
          AND NOT EXISTS (SELECT 1 FROM "Email" x WHERE x."studentId" = e."studentId" AND
                (x.status = 'SENDING' OR x."sentAt" > ${new Date(now.getTime() - MIN_GAP_MS)}))
        ORDER BY e."scheduledFor" LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
      RETURNING id`;
    return rows.length ? { id: rows[0].id, token } : null;
  } catch (err: any) {
    if (/23505|one_sending_per_student/.test(`${err?.meta?.code ?? ''} ${err?.message ?? ''}`)) return null; // another worker is sending for this student
    throw err;
  }
}

const release = (id: string, token: string, data: Record<string, unknown> = {}) =>
  db.email.updateMany({ where: { id, claimToken: token, status: 'SENDING' }, data: { status: 'SCHEDULED', claimToken: null, ...data } });

async function markSent(e: Loaded, token: string, ref: { messageId: string; threadId: string; sentAt?: Date }, to: string, sandboxed: boolean | null) {
  const done = await db.email.updateMany({
    where: { id: e.id, claimToken: token, status: 'SENDING' },
    data: { status: 'SENT', sentAt: ref.sentAt ?? new Date(), sentTo: to, sandboxed, gmailMessageId: ref.messageId, gmailThreadId: ref.threadId, gmailDraftId: null, claimToken: null, error: null },
  });
  if (done.count) await audit('worker', 'email.sent', 'Email', e.id, { to, for: e.toEmail, sandboxed });
}

/**
 * Asks Gmail what happened. Safe answers only: sent, or the draft is still there (so it was not sent).
 * Otherwise wait (`final` = false) or hand it to a person.
 */
async function reconcile(e: Loaded, token: string, final: boolean, why: string) {
  if (!e.gmailDraftId || !e.gmailThreadId) {
    await release(e.id, token, { attempts: { increment: 1 }, notBefore: minutes(2), error: why }); // no draft was saved, so nothing was sent
    return;
  }
  const sent = await mail().findSent(e.studentId, e.gmailThreadId);
  if (sent) return markSent(e, token, sent, e.draftTo ?? e.toEmail, e.sandboxed);
  const still = await mail().draftRecipient(e.studentId, e.gmailDraftId);
  if (still !== null) {
    if (e.attempts + 1 < MAX_ATTEMPTS) await release(e.id, token, { attempts: { increment: 1 }, notBefore: minutes(3), error: why });
    else await uncertain(e, token, `Gmail did not send this draft after several tries: ${why}`);
    return;
  }
  if (!final) return; // Gmail may need a moment to show a sent message; looked at again in a few minutes
  await uncertain(e, token, 'The Gmail draft is gone and no sent copy was found. Look in the student’s Gmail before doing anything.');
}

async function uncertain(e: Loaded, token: string, error: string) {
  await db.email.updateMany({ where: { id: e.id, claimToken: token, status: 'SENDING' }, data: { status: 'UNCERTAIN', error: error.slice(0, 500) } });
  await db.email.updateMany({ where: { id: e.id, status: 'UNCERTAIN' }, data: { claimToken: null } });
  await audit('worker', 'email.uncertain', 'Email', e.id, { error });
}

async function sendOne(id: string, token: string, now: Date) {
  const e = await load(id);
  let tried = false;
  try {
    if (e.campaign.paused || (await outreachPaused())) return void (await release(id, token));
    const plan = planOf(e.campaign);
    if (!(e.sendNow && testMode(e.campaign.live)) && !insideWindow(now, plan)) return void (await release(id, token));

    const earlier = await db.message.findFirst({ where: { studentId: e.studentId, outgoing: false, fromEmail: e.toEmail, kind: 'PROFESSOR' }, select: { id: true } });
    if (earlier && !ownTestAddress(e.toEmail)) {
      if (e.gmailDraftId) await mail().deleteDraft(e.studentId, e.gmailDraftId).catch(() => undefined);
      await db.email.updateMany({ where: { id, claimToken: token }, data: { status: 'CANCELLED', claimToken: null, gmailDraftId: null, error: 'Not sent: this professor already wrote to the student.' } });
      return;
    }

    const today = dayKey(now, plan.timezone);
    const recent = await db.email.findMany({ where: { studentId: e.studentId, sentAt: { gte: new Date(now.getTime() - 26 * 3600_000) } }, select: { sentAt: true } });
    if (recent.filter((r) => dayKey(r.sentAt!, plan.timezone) === today).length >= Math.min(plan.maxPerDay, slowCap(today, (await planWithStart(db, e.campaign, now)).slowFrom))) {
      await release(id, token);
      await moveToNextSlots(e.campaignId, [id], now, { notToday: true });
      return;
    }

    const tooNew = testMode(e.campaign.live) ? null : await tooNewFor(e.studentId, [e.toEmail]);
    if (tooNew) {
      await release(id, token);
      const stopped = await db.campaign.updateMany({ where: { id: e.campaignId, paused: false }, data: { paused: true, pauseReason: tooNew } });
      if (stopped.count) await audit('worker', 'campaign.account_too_new', 'Campaign', e.campaignId);
      return;
    }

    const d = await ensureDraft(e, token);
    const current = await mail().draftRecipient(e.studentId, d.draftId);
    if (current === null) return void (await reconcile(await load(id), token, false, 'The draft was missing in Gmail.'));
    if (!same(current, d.to)) return void (await uncertain(e, token, `Somebody changed the recipient in Gmail to ${current || 'nothing'}. It was not sent.`));

    // last look: still ours, and nobody pressed pause
    const mine = await db.email.updateMany({ where: { id, claimToken: token, status: 'SENDING', campaign: { paused: false, status: 'ACTIVE', live: e.campaign.live } }, data: { claimedAt: new Date() } });
    if (!mine.count) return void (await release(id, token));

    tried = true;
    const ref = await mail().sendDraft(e.studentId, d.draftId);
    await markSent(await load(id), token, ref, d.to, d.sandboxed);
  } catch (err: any) {
    const me = err instanceof MailError ? err : null;
    const text = String(err?.message ?? err).slice(0, 400);
    if (me) await noteMailboxError(e.studentId, me);
    if (me?.kind === 'REJECTED') {
      // definitely not sent: back to review, with Gmail's reason
      const flags = [...(e.flags as any[]), { code: 'gmail_rejected', level: 'block', text: `Gmail refused it: ${text}` }];
      await db.email.updateMany({ where: { id, claimToken: token, status: 'SENDING' }, data: { status: 'DRAFT', claimToken: null, scheduledFor: null, flags, error: text } });
      return;
    }
    if (me?.kind === 'AUTH' || me?.kind === 'RATE') return void (await release(id, token, { error: text, notBefore: minutes(5) }));
    if (tried || me?.kind === 'NOT_FOUND') return void (await reconcile(await load(id), token, false, text));
    await release(id, token, { attempts: { increment: 1 }, notBefore: minutes(2), error: text });
  }
}

/** Emails left half way by a worker that stopped. */
export async function recoverStuck() {
  const stuck = await db.email.findMany({ where: { status: 'SENDING', claimedAt: { lt: new Date(Date.now() - CLAIM_MS) } }, take: 20, select: { id: true, claimToken: true } });
  for (const s of stuck) {
    const token = crypto.randomUUID();
    const took = await db.email.updateMany({
      where: { id: s.id, status: 'SENDING', claimToken: s.claimToken, claimedAt: { lt: new Date(Date.now() - CLAIM_MS) } },
      data: { claimToken: token, claimedAt: new Date() },
    });
    if (!took.count) continue;
    const e = await load(s.id);
    try {
      await reconcile(e, token, true, 'Sending was interrupted.');
    } catch (err) {
      if (err instanceof MailError) await noteMailboxError(e.studentId, err); // stays SENDING and is looked at again
    }
  }
}

/** One round of sending. Returns how many emails were handled. */
export async function sendDue(max = 10, now = new Date()): Promise<number> {
  if (sandboxMissing() || (await outreachPaused())) return 0;
  let n = 0;
  const running: Promise<void>[] = [];
  while (n < max) {
    const c = await claimDue(now);
    if (!c) break;
    n++;
    running.push(sendOne(c.id, c.token, now).catch((err) => console.error('[send]', c.id, err?.message ?? err)));
  }
  await Promise.all(running);
  return n;
}
