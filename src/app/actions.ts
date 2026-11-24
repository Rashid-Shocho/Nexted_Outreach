'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireStaff, signIn, signOut } from '@/lib/auth';
import { audit, db } from '@/lib/db';
import { env } from '@/lib/env';
import { decrypt, encrypt, hashPassword, randomToken, sha256 } from '@/lib/crypto';
import { checkRows, FIELDS, guessMapping, normaliseEmail, readSheet, type Mapping } from '@/lib/excel';
import { readGoogleSheet, SheetError } from '@/lib/gsheet';
import { authUrl } from '@/lib/mail/gmail';
import { PDF_RULES } from '@/lib/prompt';
import * as C from '@/lib/pipeline/campaigns';
import { pdfText, phoneIn } from '@/lib/pipeline/profile';
import { replyToThread, syncMailbox } from '@/lib/pipeline/inbox';
import { knownContacts } from '@/lib/queries';

export interface Result {
  ok?: string;
  error?: string;
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** Runs a change as the signed-in staff member and turns expected problems into a message. */
async function run(fn: (staff: { id: string; name: string; email: string }) => Promise<string | void>): Promise<Result> {
  const staff = await requireStaff();
  let ok: string | void;
  try {
    ok = await fn(staff);
  } catch (e: any) {
    if (e?.digest?.startsWith?.('NEXT_')) throw e; // redirect()
    if (e instanceof C.UserError) return { error: e.message };
    console.error('[action]', e);
    return { error: 'Something went wrong. Nothing more was changed; please try again.' };
  }
  revalidatePath('/', 'layout');
  return { ok: ok ?? 'Saved.' };
}

// ---------------------------------------------------------------- sign in

export async function login(_: Result, f: FormData): Promise<Result> {
  const error = await signIn(text(f, 'email'), String(f.get('password') ?? ''));
  if (error) return { error };
  redirect('/students');
}

export async function logout() {
  await signOut();
  redirect('/login');
}

// ---------------------------------------------------------------- staff

const tempPassword = () => crypto.randomBytes(12).toString('base64url');

export async function addStaff(_: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const email = normaliseEmail(text(f, 'email'));
    const name = text(f, 'name');
    if (!email || !name) throw new C.UserError('Give a name and a valid email.');
    if (await db.staff.findUnique({ where: { email } })) throw new C.UserError('That email already has an account.');
    const pw = tempPassword();
    const row = await db.staff.create({ data: { email, name, passwordHash: await hashPassword(pw) } });
    await audit(s.email, 'staff.added', 'Staff', row.id);
    return `Account made. First password for ${email}: ${pw} (shown once)`;
  });
}

export async function changePassword(_: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const pw = String(f.get('password') ?? '');
    if (pw.length < 12) throw new C.UserError('Use at least 12 characters.');
    await db.staff.update({ where: { id: s.id }, data: { passwordHash: await hashPassword(pw) } });
    await db.session.deleteMany({ where: { staffId: s.id } });
    redirect('/login');
  });
}

export async function setStaffActive(id: string, active: boolean, _: Result): Promise<Result> {
  return run(async (s) => {
    if (id === s.id) throw new C.UserError('You cannot switch off your own account.');
    await db.staff.update({ where: { id }, data: { active } });
    if (!active) await db.session.deleteMany({ where: { staffId: id } });
    await audit(s.email, active ? 'staff.enabled' : 'staff.disabled', 'Staff', id);
  });
}

const SWITCHES = { writing: 'writingPaused', sending: 'outreachPaused', inbox: 'inboxPaused' } as const;

/** Stops or starts the worker's jobs. The worker looks before every step, so it takes up to half a minute. */
export async function setStops(what: ('writing' | 'sending' | 'inbox')[], stopped: boolean, _: Result): Promise<Result> {
  return run(async (s) => {
    for (const w of what) {
      const key = SWITCHES[w];
      if (!key) continue;
      await db.setting.upsert({ where: { key }, create: { key, value: stopped }, update: { value: stopped } });
    }
    await audit(s.email, stopped ? 'work.stopped' : 'work.resumed', 'Setting', what.join());
    return stopped ? 'Stopped. What is in the middle of a step finishes that step.' : 'Running again.';
  });
}

export async function cancelCampaign(id: string, _: Result): Promise<Result> {
  return run(async (s) => `${await C.cancelCampaign(id, s.email)} emails cancelled. Their drafts are being removed from Gmail.`);
}

// ---------------------------------------------------------------- students

export async function addStudent(_: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const email = normaliseEmail(text(f, 'email'));
    const fullName = text(f, 'fullName').replace(/\s+/g, ' ');
    if (!fullName || !email) throw new C.UserError('Give the student’s name and Gmail address.');
    if (await db.student.findUnique({ where: { email } })) throw new C.UserError('A student with this Gmail already exists.');
    const consent = f.get('consent') === 'on';
    const isDemo = env().APP_ENV !== 'production' && f.get('demo') === 'on';
    const profile = await readPdf(f.get('profile'), 'Profile');
    const cv = await readPdf(f.get('cv'), 'CV');
    const st = await db.student.create({ data: { fullName, email, isDemo, phone: text(f, 'phone') || (profile && phoneIn(profile.text)) || null, notes: text(f, 'notes') || null, ...(consent ? { consentAt: new Date(), consentBy: s.email } : {}) } });
    if (profile) await storeProfile(st.id, profile);
    if (cv) await storeCv(st.id, cv);
    await audit(s.email, 'student.added', 'Student', st.id);
    redirect(`/students/${st.id}`);
  });
}

export async function updateStudent(id: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const fullName = text(f, 'fullName').replace(/\s+/g, ' ');
    if (!fullName) throw new C.UserError('The name is needed.');
    const before = await db.student.findUniqueOrThrow({ where: { id } });
    const consent = f.get('consent') === 'on';
    await db.student.update({
      where: { id },
      data: { fullName, phone: text(f, 'phone').slice(0, 40) || null, signature: String(f.get('signature') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 400) || null, notes: text(f, 'notes') || null, ...(consent && !before.consentAt ? { consentAt: new Date(), consentBy: s.email } : {}), ...(!consent && before.consentAt ? { consentAt: null, consentBy: null } : {}) },
    });
    await audit(s.email, 'student.updated', 'Student', id, { consent });
    if (!consent && before.consentAt) await C.endLive(id, s.email);
  });
}

export async function connectGmail(studentId: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const st = await db.student.findUniqueOrThrow({ where: { id: studentId } });
    if (!st.consentAt && !st.isDemo) throw new C.UserError('Record the student’s consent first.');
    if (env().EMAIL_TRANSPORT === 'fake') {
      const data = { email: st.email, encryptedRefreshToken: encrypt('fake'), status: 'CONNECTED' as const, lastError: null, nextSyncAt: new Date() };
      await db.mailbox.upsert({ where: { studentId }, create: { studentId, ...data }, update: data });
      await audit(s.email, 'gmail.connected', 'Student', studentId, { fake: true });
      return 'Connected to the pretend Gmail (development).';
    }
    const state = randomToken();
    await db.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await db.oAuthState.create({ data: { stateHash: sha256(state), studentId, staffId: s.id, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    redirect(authUrl(state, st.email));
  });
}

export async function disconnectGmail(studentId: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const mb = await db.mailbox.findUnique({ where: { studentId } });
    if (!mb) return;
    if (env().EMAIL_TRANSPORT === 'gmail') {
      await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: decrypt(mb.encryptedRefreshToken) }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    }
    await db.mailbox.delete({ where: { id: mb.id } });
    await audit(s.email, 'gmail.disconnected', 'Student', studentId);
    return 'Disconnected. Nothing more is read or sent for this student.';
  });
}

export async function checkMailNow(studentId: string, _: Result): Promise<Result> {
  return run(async () => {
    const n = await syncMailbox(studentId);
    return n ? `${n} new.` : 'No new mail.';
  });
}

/** Many students at once, from Excel: name, Gmail, phone, about. */
export async function importStudents(_: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const file = f.get('file');
    if (!(file instanceof File) || !file.size || file.size > 2 * 1024 * 1024) throw new C.UserError('Choose an Excel or CSV file under 2 MB.');
    if (f.get('consent') !== 'on') throw new C.UserError('Confirm that all of these students agreed in writing.');
    let sheet;
    try {
      sheet = await readSheet(file.name, Buffer.from(await file.arrayBuffer()));
    } catch (e: any) {
      throw new C.UserError(e?.message ?? 'The file could not be read.');
    }
    const col = (re: RegExp) => sheet.headers.findIndex((h) => re.test(h));
    const at = { email: col(/e-?mail/i), name: col(/^(?!.*mail).*name/i), phone: col(/phone|mobile|whatsapp/i), about: col(/about|profile|background|note/i) };
    if (at.name < 0 || at.email < 0) throw new C.UserError('The file needs the headings Name and Email (Phone and About are optional).');
    if (sheet.rows.length > 500) throw new C.UserError('At most 500 students per file.');
    let added = 0;
    const skipped: string[] = [];
    for (const r of sheet.rows) {
      const email = normaliseEmail(r[at.email] ?? '');
      const fullName = (r[at.name] ?? '').trim();
      if (!email || !fullName || (await db.student.findUnique({ where: { email } }))) {
        skipped.push(r[at.email] || fullName || '(empty)');
        continue;
      }
      await db.student.create({ data: { email, fullName, phone: at.phone < 0 ? null : r[at.phone]?.trim() || null, notes: at.about < 0 ? null : r[at.about]?.trim() || null, consentAt: new Date(), consentBy: s.email } });
      added++;
    }
    await audit(s.email, 'students.imported', 'Student', null, { added, skipped: skipped.length });
    return `${added} added.${skipped.length ? ` ${skipped.length} skipped (already there, or no valid name and email): ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}` : ''}`;
  });
}

/** A link the student opens on their own phone. No staff login is needed there. */
export async function makeConnectLink(studentId: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const st = await db.student.findUniqueOrThrow({ where: { id: studentId } });
    if (!st.consentAt && !st.isDemo) throw new C.UserError('Record the student’s consent first.');
    const token = randomToken();
    await db.connectLink.create({ data: { tokenHash: sha256(token), studentId, createdBy: s.email, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    await audit(s.email, 'gmail.link_made', 'Student', studentId);
    return `${env().APP_URL.replace(/\/$/, '')}/connect/${token}`;
  });
}

/** Pressed by the student on the link's page. */
export async function startConnect(token: string): Promise<void> {
  const link = await db.connectLink.findUnique({ where: { tokenHash: sha256(token) } });
  if (!link || link.usedAt || link.expiresAt < new Date()) redirect('/connect/done?r=expired');
  const st = await db.student.findUnique({ where: { id: link.studentId } });
  if (!st || (!st.consentAt && !st.isDemo)) redirect('/connect/done?r=expired');
  if (env().EMAIL_TRANSPORT === 'fake') {
    const data = { email: st.email, encryptedRefreshToken: encrypt('fake'), status: 'CONNECTED' as const, lastError: null, nextSyncAt: new Date() };
    await db.mailbox.upsert({ where: { studentId: st.id }, create: { studentId: st.id, ...data }, update: data });
    await db.connectLink.update({ where: { id: link.id }, data: { usedAt: new Date() } });
    redirect('/connect/done?r=ok');
  }
  const state = randomToken();
  const nonce = randomToken();
  await db.oAuthState.create({ data: { stateHash: sha256(state), studentId: st.id, nonceHash: sha256(nonce), linkId: link.id, expiresAt: new Date(Date.now() + 10 * 60_000) } });
  (await cookies()).set('connect', nonce, { httpOnly: true, sameSite: 'lax', secure: env().APP_ENV === 'production', path: '/api/gmail', maxAge: 600 });
  redirect(authUrl(state, st.email));
}

// ---------------------------------------------------------------- CV

interface Pdf {
  name: string;
  bytes: Buffer;
  text: string;
}

async function readPdf(file: FormDataEntryValue | null, what: string): Promise<Pdf | null> {
  if (!(file instanceof File) || !file.size) return null;
  if (file.size > 8 * 1024 * 1024) throw new C.UserError(`The ${what} must be under 8 MB.`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new C.UserError(`The ${what} must be a PDF. In Word use File, Save as, PDF.`);
  let t = '';
  if (what === 'Profile') {
    t = await pdfText(bytes).catch(() => '');
    if (t.length < 300) throw new C.UserError('No readable text was found in this Profile. A scanned PDF or one with a password cannot be read: save it from Word as PDF.');
  }
  return { name: file.name.slice(0, 200), bytes, text: t };
}

async function storeProfile(studentId: string, p: Pdf) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${studentId} FOR UPDATE`;
    const last = await tx.studentProfile.aggregate({ where: { studentId }, _max: { version: true } });
    const row = await tx.studentProfile.create({ data: { studentId, version: (last._max.version ?? 0) + 1, fileName: p.name, sizeBytes: p.bytes.length, content: new Uint8Array(p.bytes), text: p.text }, select: { id: true, version: true } });
    const phone = phoneIn(p.text);
    if (phone) await tx.student.updateMany({ where: { id: studentId, phone: null }, data: { phone } });
    return row;
  });
}

async function storeCv(studentId: string, p: Pdf) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${studentId} FOR UPDATE`;
    const last = await tx.cv.aggregate({ where: { studentId }, _max: { version: true } });
    return tx.cv.create({ data: { studentId, version: (last._max.version ?? 0) + 1, fileName: p.name, mimeType: 'application/pdf', sizeBytes: p.bytes.length, sha256: sha256(p.bytes), content: new Uint8Array(p.bytes) }, select: { id: true, version: true } });
  });
}

export async function uploadCv(studentId: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const pdf = await readPdf(f.get('file'), 'CV');
    if (!pdf) throw new C.UserError('Choose a PDF.');
    const cv = await storeCv(studentId, pdf);
    await audit(s.email, 'cv.uploaded', 'Cv', cv.id);
    return `CV version ${cv.version} uploaded. It will be attached to the drafts.`;
  });
}

export async function uploadProfile(studentId: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const pdf = await readPdf(f.get('file'), 'Profile');
    if (!pdf) throw new C.UserError('Choose the Profile PDF.');
    const p = await storeProfile(studentId, pdf);
    await audit(s.email, 'profile.uploaded', 'StudentProfile', p.id);
    return `Profile version ${p.version} uploaded. It is being read now.`;
  });
}

export async function retryProfile(id: string, _: Result): Promise<Result> {
  return run(async () => {
    await db.studentProfile.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, error: null, notBefore: null } });
    return 'Reading again.';
  });
}

export async function saveBrief(id: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const brief = String(f.get('brief') ?? '').replace(/\r\n/g, '\n').trim();
    if (brief.length < C.MIN_ABOUT) throw new C.UserError(`The brief needs at least ${C.MIN_ABOUT} characters.`);
    if (brief.length > 5000) throw new C.UserError('The brief can have at most 5000 characters.');
    await db.studentProfile.updateMany({ where: { id, status: 'READY' }, data: { brief } });
    await audit(s.email, 'profile.brief_edited', 'StudentProfile', id);
    return 'Saved. Emails written from now on use it.';
  });
}

// ---------------------------------------------------------------- professor list

export async function uploadList(studentId: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const file = f.get('file');
    const link = text(f, 'link');
    let name: string;
    let sheet;
    try {
      if (link) {
        const g = await readGoogleSheet(link);
        name = g.name;
        sheet = await readSheet('google.csv', g.csv);
      } else {
        if (!(file instanceof File) || !file.size) throw new C.UserError('Choose a file or paste a Google Sheets link.');
        if (file.size > 5 * 1024 * 1024) throw new C.UserError('The file must be under 5 MB.');
        name = file.name;
        sheet = await readSheet(file.name, Buffer.from(await file.arrayBuffer()));
      }
    } catch (e: any) {
      if (!(e instanceof C.UserError) && !(e instanceof SheetError) && !(e instanceof Error)) throw e;
      throw new C.UserError(e.message);
    }
    const l = await db.professorList.create({
      data: { studentId, fileName: name.slice(0, 200), headers: sheet.headers, rows: sheet.rows, mapping: guessMapping(sheet.headers) as any, createdBy: s.email },
      select: { id: true },
    });
    redirect(`/lists/${l.id}`);
  });
}

export async function saveMapping(id: string, _: Result, f: FormData): Promise<Result> {
  return run(async () => {
    const map: Mapping = {};
    for (const k of FIELDS) {
      const v = text(f, k);
      if (v !== '') map[k] = Number(v);
    }
    await db.professorList.updateMany({ where: { id, status: 'PREVIEW' }, data: { mapping: map as any } });
    return 'Columns updated.';
  });
}

export async function importList(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const l = await db.professorList.findUniqueOrThrow({ where: { id } });
    if (l.status !== 'PREVIEW') throw new C.UserError('This list was already imported.');
    const rows = l.rows as string[][];
    const map = l.mapping as Mapping;
    const good = checkRows(rows, map, await knownContacts(l.studentId, rows, map)).filter((r) => !r.errors.length);
    if (!good.length) throw new C.UserError('No row can be imported. Check the column choices.');
    await db.$transaction(async (tx) => {
      const claimed = await tx.professorList.updateMany({ where: { id, status: 'PREVIEW' }, data: { status: 'IMPORTED' } });
      if (!claimed.count) throw new C.UserError('This list was already imported.');
      await tx.professor.createMany({
        data: good.map((r) => ({ listId: id, rowNumber: r.rowNumber, name: r.values.name, email: r.email!, university: r.values.university || null, department: r.values.department || null, researchArea: r.values.researchArea || null, country: r.values.country || null, notes: r.values.notes || null })),
      });
    });
    await audit(s.email, 'list.imported', 'ProfessorList', id, { rows: good.length });
    redirect(`/students/${l.studentId}`);
  });
}

export async function deleteList(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const l = await db.professorList.findUniqueOrThrow({ where: { id }, include: { _count: { select: { campaigns: true } } } });
    if (l._count.campaigns) throw new C.UserError('A campaign uses this list.');
    await db.professorList.delete({ where: { id } });
    await audit(s.email, 'list.deleted', 'ProfessorList', id);
    redirect(`/students/${l.studentId}`);
  });
}

// ---------------------------------------------------------------- campaigns

const Plan = z.object({
  startDate: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  timezone: z.string(),
  minPerDay: z.coerce.number(),
  maxPerDay: z.coerce.number(),
  weekdays: z.array(z.coerce.number().int()),
});

function planFrom(f: FormData) {
  const p = Plan.safeParse({ ...Object.fromEntries(['startDate', 'windowStart', 'windowEnd', 'timezone', 'minPerDay', 'maxPerDay'].map((k) => [k, text(f, k)])), weekdays: f.getAll('weekdays') });
  if (!p.success) throw new C.UserError('Please check the schedule.');
  return p.data;
}

/** Real sending is typed, not clicked. */
function wantsLive(f: FormData): boolean {
  const t = text(f, 'live');
  const mode = text(f, 'mode');
  if (mode === 'test' && t) throw new C.UserError('You typed LIVE but chose Test. Choose Real, or empty that field.');
  if (mode === 'real' && !t) throw new C.UserError('For real sending type LIVE in the field next to it.');
  if (t === '') return false;
  if (t !== 'LIVE') throw new C.UserError('For real sending type LIVE in capital letters.');
  return true;
}

export async function setLive(id: string, on: boolean, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    if (on && !wantsLive(f)) throw new C.UserError('Type LIVE in capital letters.');
    await C.setLive(id, on, s.email);
    return on ? 'LIVE: this campaign now sends to the real addresses.' : 'Back in test mode.';
  });
}

export async function setSlowStart(id: string, on: boolean, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.setSlowStart(id, on, s.email);
    return on ? 'Slow start is on. The send times were changed.' : 'Slow start is off. The send times were changed.';
  });
}

export async function createCampaign(studentId: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const c = await C.createCampaign({ ...planFrom(f), studentId, listId: text(f, 'listId'), cvId: text(f, 'cvId'), name: text(f, 'name').slice(0, 120), intake: text(f, 'intake').slice(0, 100), instructions: text(f, 'instructions').slice(0, 1500), autoSchedule: f.get('autoSchedule') === 'on', replace: f.get('replace') === 'on', live: wantsLive(f), ...(f.has('mode') ? { slowStart: f.get('slowStart') === 'on' } : {}) }, s.email);
    redirect(`/campaigns/${c.id}`);
  });
}

export async function approveCampaign(id: string, _: Result): Promise<Result> {
  return run(async (s) => `${await C.approveCampaign(id, s.email)} emails scheduled. They are now being put into the student’s Gmail Drafts.`);
}

export async function saveSchedule(id: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    await C.changeSchedule(id, planFrom(f), s.email);
    return 'Schedule saved.';
  });
}

export async function pauseCampaign(id: string, paused: boolean, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.setPaused(id, paused, s.email);
    return paused ? 'Paused.' : 'Resumed.';
  });
}

export async function saveEmail(id: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => C.editEmail(id, { subject: text(f, 'subject'), body: String(f.get('body') ?? '') }, s.email));
}

export async function rewriteEmail(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.rewriteEmail(id, s.email);
    return 'It will be written again in a moment.';
  });
}

export async function acceptFlags(id: string, _: Result): Promise<Result> {
  return run(async (s) => C.acceptFlags(id, s.email));
}

export async function scheduleEmail(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    const e = await db.email.findUniqueOrThrow({ where: { id } });
    await C.approveCampaign(e.campaignId, s.email, id);
    return 'Scheduled.';
  });
}

export async function cancelEmail(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.cancelEmail(id, s.email);
    return 'Cancelled.';
  });
}

export async function setAutoSchedule(id: string, on: boolean, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.setAutoSchedule(id, on, s.email);
    return on ? 'Every email that passes the checks now gets its time by itself.' : 'Emails wait for “Approve and schedule”.';
  });
}

export async function restoreEmail(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.restoreEmail(id, s.email);
    return 'It is back.';
  });
}

export async function resolveUncertain(id: string, answer: 'sent' | 'send_again', _: Result): Promise<Result> {
  return run(async (s) => C.resolveUncertain(id, answer, s.email));
}

export async function rewriteAll(id: string, _: Result): Promise<Result> {
  return run(async (s) => `${await C.rewriteAll(id, s.email)} emails will be written again with the current rules.`);
}

export async function sendTestNow(id: string, _: Result): Promise<Result> {
  return run(async (s) => {
    await C.sendTestNow(id, s.email);
    return 'It leaves within about half a minute, to the test inbox.';
  });
}

// ---------------------------------------------------------------- writing rules

export async function saveRules(_: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const value = { memory: text(f, 'memory'), system: text(f, 'system'), email: text(f, 'email'), extra: text(f, 'extra'), examples: text(f, 'examples') };
    if (!value.system || !value.email) throw new C.UserError('The assistant and email rules cannot be empty.');
    if (Object.values(value).some((v) => v.length > 8000)) throw new C.UserError('Each text can have at most 8000 characters.');
    await db.setting.upsert({ where: { key: 'writing' }, create: { key: 'writing', value }, update: { value } });
    await audit(s.email, 'rules.saved', 'Setting', 'writing', value);
    return 'Saved. New emails use these rules; for existing ones press “Write all again” in the campaign.';
  });
}

export async function restoreRules(_: Result): Promise<Result> {
  return run(async (s) => {
    await db.setting.deleteMany({ where: { key: 'writing' } });
    await audit(s.email, 'rules.restored', 'Setting', 'writing', { ...PDF_RULES });
    return 'The original rules are back.';
  });
}

// ---------------------------------------------------------------- inbox

export async function setUnread(threadId: string, unread: boolean, _: Result): Promise<Result> {
  return run(async () => {
    await db.thread.update({ where: { id: threadId }, data: { unread } });
    return unread ? 'Marked unread.' : 'Marked read.';
  });
}

export async function sendReply(threadId: string, _: Result, f: FormData): Promise<Result> {
  return run(async (s) => {
    const key = text(f, 'clientKey');
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new C.UserError('Reload the page and try again.');
    await replyToThread(threadId, String(f.get('body') ?? '').slice(0, 20_000), key, s.email);
    return 'Reply sent from the student’s Gmail.';
  });
}
