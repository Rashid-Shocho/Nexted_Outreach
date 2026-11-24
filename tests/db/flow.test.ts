import './setup';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { DateTime } from 'luxon';
import { db } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { encrypt } from '../../src/lib/crypto';
import { blocked } from '../../src/lib/checks';
import { fakeHooks, fakeIncoming } from '../../src/lib/mail/fake';
import { MailError } from '../../src/lib/mail';
import { draftNext } from '../../src/lib/pipeline/drafting';
import * as C from '../../src/lib/pipeline/campaigns';
import { profileNext } from '../../src/lib/pipeline/profile';
import { cleanUpCancelled, moveLate, pushDrafts, recoverStuck, sendDue } from '../../src/lib/pipeline/sender';
import { noticeDeletedDrafts, replyToThread, syncMailbox } from '../../src/lib/pipeline/inbox';
import { demoPdf, demoProfessors, DEMO_ABOUT, DEMO_CV } from '../../scripts/seed';
import { wipe } from './setup';

const ALWAYS = { windowStart: '00:00', windowEnd: '23:59', timezone: 'Asia/Dhaka', weekdays: [1, 2, 3, 4, 5, 6, 7] };
const today = () => DateTime.now().setZone('Asia/Dhaka').toISODate()!;

beforeEach(async () => {
  fakeHooks.before = undefined;
  fakeHooks.after = undefined;
  fakeHooks.oldMessages = undefined;
  (env() as any).INBOX_SCOPE = 'all';
  (env() as any).EMAIL_SANDBOX_TO = 'sandbox@example.test';
  (env() as any).EMAIL_SANDBOX_ALLOW = undefined;
  (env() as any).EMAIL_SANDBOX = true;
  await wipe();
});
after(() => db.$disconnect());

let n = 0;
/** A student with everything ready and `count` approved emails. */
async function ready(count: number, opts: { max?: number; approve?: boolean; auto?: boolean; wait?: boolean } = {}) {
  const email = `student${++n}@gmail.com`;
  const s = await db.student.create({ data: { fullName: 'Ayesha Rahman Demo', email, isDemo: true, phone: '+880 1700 000000', notes: DEMO_ABOUT } });
  await db.mailbox.create({ data: { studentId: s.id, email, encryptedRefreshToken: encrypt('x') } });
  const bytes = demoPdf(DEMO_CV);
  const cv = await db.cv.create({ data: { studentId: s.id, version: 1, fileName: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: 'x', content: bytes } });
  const list = await db.professorList.create({ data: { studentId: s.id, fileName: 'list.xlsx', status: 'IMPORTED', headers: [], rows: [], mapping: {}, createdBy: 't' } });
  await db.professor.createMany({ data: demoProfessors(count).map((p, i) => ({ listId: list.id, rowNumber: i + 1, name: p.name, email: p.email, university: p.university, researchArea: p.research || null })) });
  const c = await C.createCampaign({ studentId: s.id, listId: list.id, cvId: cv.id, name: 'c', startDate: today(), minPerDay: opts.max ?? 20, maxPerDay: opts.max ?? 20, autoSchedule: opts.auto ?? false, ...ALWAYS }, 'staff');
  if (!opts.wait) while (await draftNext());
  if (opts.approve !== false && !opts.auto && !opts.wait) await C.approveCampaign(c.id, 'staff');
  return { s, c, cv, list, email };
}
const due = (campaignId: string, take?: number) =>
  db.email.findMany({ where: { campaignId, status: 'SCHEDULED' }, orderBy: { scheduledFor: 'asc' }, take }).then(async (rows) => {
    await db.email.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { scheduledFor: new Date(Date.now() - 1000) } });
    return rows;
  });
const noGap = (studentId: string) => db.email.updateMany({ where: { studentId, sentAt: { not: null } }, data: { sentAt: new Date(Date.now() - 60_000) } });
const sentMails = (mailbox: string) => db.fakeMail.count({ where: { mailbox, labels: { has: 'SENT' } } });
const get = (id: string) => db.email.findUniqueOrThrow({ where: { id } });
const age = (id: string) => db.email.update({ where: { id }, data: { claimedAt: new Date(Date.now() - 6 * 60_000) } });
/** Sends exactly one email and returns it. */
async function sendFirst(x: Awaited<ReturnType<typeof ready>>) {
  const [e] = await due(x.c.id, 1);
  await sendDue(1);
  return get(e.id);
}

test('250 emails are written, checked, scheduled and put into Gmail with the CV', async () => {
  const x = await ready(250, { approve: false });
  const drafts = await db.email.findMany({ where: { campaignId: x.c.id } });
  assert.equal(drafts.length, 250);
  assert.ok(drafts.every((d) => d.status === 'DRAFT' && !blocked(d.flags)), JSON.stringify(drafts.find((d) => blocked(d.flags) || d.status !== 'DRAFT')));
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).status, 'REVIEW');
  assert.equal(await C.approveCampaign(x.c.id, 'staff'), 250);
  while (await pushDrafts());
  const inGmail = await db.fakeMail.findMany({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } });
  assert.ok(inGmail.length >= 249, String(inGmail.length)); // one due within a minute may be left to the sender
  assert.ok(inGmail.every((d) => (d.headers as any).to === 'sandbox@example.test' && (d.files as any[])[0].name === 'CV_Ayesha_Rahman_Demo.pdf' && Buffer.from((d.files as any[])[0].data, 'base64').equals(demoPdf(DEMO_CV))));
  assert.equal(new Set(inGmail.map((d) => (d.headers as any).subject.match(/to (\S+)\]/)[1])).size, inGmail.length);
  const perDay = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "Email" WHERE "campaignId" = ${x.c.id} GROUP BY ("scheduledFor" AT TIME ZONE 'Asia/Dhaka')::date`;
  assert.ok(perDay.every((r) => Number(r.n) <= 20));
  assert.equal(await sentMails(x.email), 0, 'nothing is sent early');
});

test('an email goes out once, from the Gmail draft', async () => {
  const x = await ready(3);
  await pushDrafts();
  const e = await sendFirst(x);
  assert.equal(e.status, 'SENT');
  assert.equal(e.sentTo, 'sandbox@example.test');
  assert.equal(await sentMails(x.email), 1);
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
});

test('crash right after Gmail sent it: found as sent, no second copy', async () => {
  const x = await ready(2);
  const [e] = await due(x.c.id, 1);
  fakeHooks.after = (op) => {
    if (op === 'sendDraft') throw new Error('process killed');
  };
  fakeHooks.before = (op) => {
    if (op === 'findSent') throw new MailError('TRANSIENT', 'down');
  };
  await sendDue(1);
  assert.equal((await get(e.id)).status, 'SENDING');
  fakeHooks.after = fakeHooks.before = undefined;
  await recoverStuck();
  assert.equal((await get(e.id)).status, 'SENDING', 'not touched before the waiting time');
  await age(e.id);
  await recoverStuck();
  assert.equal((await get(e.id)).status, 'SENT');
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
});

test('time-out where Gmail did send: settled at once', async () => {
  const x = await ready(1);
  fakeHooks.after = (op) => {
    if (op === 'sendDraft') throw new MailError('TRANSIENT', 'timeout');
  };
  const e = await sendFirst(x);
  assert.equal(e.status, 'SENT');
  assert.equal(await sentMails(x.email), 1);
});

test('time-out where Gmail did not send: same draft is tried again, then sent once', async () => {
  const x = await ready(1);
  fakeHooks.before = (op) => {
    if (op === 'sendDraft') throw new MailError('TRANSIENT', 'timeout');
  };
  let e = await sendFirst(x);
  assert.equal(e.status, 'SCHEDULED');
  const draft = e.gmailDraftId;
  fakeHooks.before = undefined;
  await db.email.update({ where: { id: e.id }, data: { notBefore: null } });
  await sendDue();
  e = await get(e.id);
  assert.equal(e.status, 'SENT');
  assert.ok(draft);
  assert.equal(await sentMails(x.email), 1);
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 0);
});

test('draft deleted in Gmail: never sent again by itself, a person decides', async () => {
  const x = await ready(1);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await pushDrafts();
  await db.fakeMail.deleteMany({ where: { mailbox: x.email } });
  let e = await sendFirst(x);
  assert.equal(e.status, 'SENDING');
  await age(e.id);
  await recoverStuck();
  e = await get(e.id);
  assert.equal(e.status, 'UNCERTAIN');
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  await C.resolveUncertain(e.id, 'send_again', 'staff');
  assert.equal((await get(e.id)).status, 'SCHEDULED');
  e = await sendFirst(x);
  assert.equal(e.status, 'SENT');
  assert.equal(await sentMails(x.email), 1);
});

test('recipient changed in Gmail: stopped', async () => {
  const x = await ready(1);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await pushDrafts();
  const d = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } });
  await db.fakeMail.update({ where: { id: d.id }, data: { headers: { ...(d.headers as object), to: 'someone@else.com' } } });
  const e = await sendFirst(x);
  assert.equal(e.status, 'UNCERTAIN');
  assert.equal(await sentMails(x.email), 0);
});

test('student pressed Send in Gmail first: noticed, not sent twice', async () => {
  const x = await ready(1);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await syncMailbox(x.s.id);
  await pushDrafts();
  const d = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } });
  await db.fakeMail.delete({ where: { id: d.id } });
  await db.fakeMail.create({ data: { mailbox: x.email, threadId: d.threadId, labels: ['SENT'], headers: { ...(d.headers as object) }, body: d.body } });
  await syncMailbox(x.s.id);
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  assert.equal(e.status, 'SENT');
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
});

test('many workers at once: one email at a time per student, each once', async () => {
  const x = await ready(6);
  await due(x.c.id);
  for (let i = 0; i < 12; i++) {
    await Promise.all([sendDue(), sendDue(), sendDue(), sendDue()]);
    await noGap(x.s.id);
  }
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SENT' } }), 6);
  assert.equal(await sentMails(x.email), 6);
  const subjects = (await db.fakeMail.findMany({ where: { mailbox: x.email, labels: { has: 'SENT' } } })).map((m) => (m.headers as any).subject);
  assert.equal(new Set(subjects).size, 6);
});

test('sending keeps a gap, so due emails do not leave together', async () => {
  const x = await ready(4);
  await due(x.c.id);
  await sendDue();
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
});

test('daily maximum holds even when more are due; the rest move to another day', async () => {
  const x = await ready(5, { max: 3 });
  await due(x.c.id);
  for (let i = 0; i < 8; i++) {
    await sendDue();
    await noGap(x.s.id);
  }
  assert.equal(await sentMails(x.email), 3);
  const rest = await db.email.findMany({ where: { campaignId: x.c.id, status: 'SCHEDULED' } });
  assert.equal(rest.length, 2);
  assert.ok(rest.every((r) => r.scheduledFor! > new Date() && DateTime.fromJSDate(r.scheduledFor!).setZone('Asia/Dhaka').toISODate()! > today()));
});

test('missed times (server was off) are moved, not sent in a burst', async () => {
  const x = await ready(5);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() - 2 * 3600_000) } });
  await moveLate();
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED', scheduledFor: { gt: new Date() } } }), 5);
});

test('outside the window nothing is sent', async () => {
  const x = await ready(1);
  const now = DateTime.now().setZone('Asia/Dhaka');
  await db.campaign.update({ where: { id: x.c.id }, data: { weekdays: [(now.weekday % 7) + 1] } }); // only tomorrow's weekday
  await due(x.c.id);
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 1);
});

test('pause (campaign and global) stops sending; resume continues', async () => {
  const x = await ready(1);
  await due(x.c.id);
  await C.setPaused(x.c.id, true, 'staff');
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  await C.setPaused(x.c.id, false, 'staff');
  await db.setting.create({ data: { key: 'outreachPaused', value: true } });
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  await db.setting.delete({ where: { key: 'outreachPaused' } });
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
});

test('lost Gmail access: mailbox asks to reconnect, email waits', async () => {
  const x = await ready(1);
  fakeHooks.before = (op) => {
    if (op === 'createDraft') throw new MailError('AUTH', 'revoked');
  };
  const e = await sendFirst(x);
  assert.equal(e.status, 'SCHEDULED');
  assert.equal((await db.mailbox.findUniqueOrThrow({ where: { studentId: x.s.id } })).status, 'RECONNECT');
  fakeHooks.before = undefined;
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
});

test('Gmail says slow down: the mailbox waits', async () => {
  const x = await ready(1);
  fakeHooks.before = (op) => {
    if (op === 'sendDraft') throw new MailError('RATE', '429');
  };
  const e = await sendFirst(x);
  assert.equal(e.status, 'SCHEDULED');
  assert.ok((await db.mailbox.findUniqueOrThrow({ where: { studentId: x.s.id } })).sendPausedUntil! > new Date());
});

test('Gmail refuses the message: back to review, not sent', async () => {
  const x = await ready(1);
  fakeHooks.before = (op) => {
    if (op === 'sendDraft') throw new MailError('REJECTED', 'Invalid To header');
  };
  const e = await sendFirst(x);
  assert.equal(e.status, 'DRAFT');
  assert.ok(blocked(e.flags));
});

test('editing a scheduled email changes the Gmail draft, and the edit is what is sent', async () => {
  const x = await ready(1);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await pushDrafts();
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  const body = e.body.replace('I have attached my CV.', 'I have **attached** my CV with much care.');
  await C.editEmail(e.id, { subject: 'Prospective PhD Researcher | new', body }, 'staff');
  const after = await sendFirst(x);
  assert.equal(after.status, 'SENT');
  const m = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email, labels: { has: 'SENT' } } });
  assert.equal((m.headers as any).subject, `[SANDBOX to ${e.toEmail}] Prospective PhD Researcher | new`);
  assert.match(m.body, /I have attached my CV with much care/);
  await assert.rejects(C.editEmail(e.id, { subject: 'x', body }, 'staff'), C.UserError);
});

test('a blocking problem keeps an email out of approval and cannot be edited into a scheduled one', async () => {
  const x = await ready(2, { approve: false });
  const [a, b] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await C.editEmail(a.id, { subject: a.subject, body: `${a.body}\n[Your Name]` }, 'staff');
  assert.equal(await C.approveCampaign(x.c.id, 'staff'), 1);
  assert.equal((await get(a.id)).status, 'DRAFT');
  await assert.rejects(C.editEmail(b.id, { subject: b.subject, body: `${b.body}\n[Your Name]` }, 'staff'), C.UserError);
  await C.acceptFlags(a.id, 'staff');
  assert.ok(blocked((await get(a.id)).flags), 'a placeholder cannot be waved through');
});

test('the same student never gets two emails to one professor; other students may', async () => {
  const x = await ready(3);
  await assert.rejects(C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'again', startDate: today(), minPerDay: 1, maxPerDay: 2, ...ALWAYS }, 'staff'), /already has an email/);
  const y = await ready(3, { approve: false });
  const flags = (await db.email.findMany({ where: { campaignId: y.c.id } })).map((e) => JSON.stringify(e.flags));
  assert.ok(flags.every((f) => f.includes('also_contacted')));
});

test('one student cannot use another student’s CV or list', async () => {
  const x = await ready(1);
  const y = await ready(1);
  const p = { name: 'x', startDate: today(), minPerDay: 1, maxPerDay: 2, ...ALWAYS };
  await assert.rejects(C.createCampaign({ ...p, studentId: x.s.id, listId: x.list.id, cvId: y.cv.id }, 's'), C.UserError);
  await assert.rejects(C.createCampaign({ ...p, studentId: x.s.id, listId: y.list.id, cvId: x.cv.id }, 's'), C.UserError);
});

test('real students need consent, and every student a text, before anything is sent to the AI', async () => {
  const x = await ready(1);
  const y = await ready(1);
  const p = { studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'x', startDate: today(), minPerDay: 1, maxPerDay: 2, ...ALWAYS };
  await db.student.update({ where: { id: x.s.id }, data: { isDemo: false } });
  await assert.rejects(C.createCampaign(p, 's'), /consent/);
  await db.student.update({ where: { id: x.s.id }, data: { isDemo: true, notes: '  ' } });
  await assert.rejects(C.createCampaign(p, 's'), /Profile/);
  // consent taken back while emails are waiting to be written
  await db.student.update({ where: { id: y.s.id }, data: { isDemo: false } });
  await db.email.updateMany({ where: { studentId: y.s.id }, data: { status: 'PENDING' } });
  await draftNext();
  const [e] = await db.email.findMany({ where: { studentId: y.s.id } });
  assert.equal(e.status, 'GEN_FAILED');
  assert.match(e.error ?? '', /consent/);
});

test('inbox: professor reply, auto-reply, bounce and private mail are told apart', async () => {
  const x = await ready(3);
  await syncMailbox(x.s.id);
  const sent = [];
  for (let i = 0; i < 3; i++) {
    sent.push(await sendFirst(x));
    await noGap(x.s.id);
  }
  const [a, b, c] = sent;
  await fakeIncoming({ mailbox: x.email, threadId: a.gmailThreadId!, from: `P <${a.toEmail}>`, subject: 'Re: x', body: 'Yes, please send more.' });
  await fakeIncoming({ mailbox: x.email, threadId: b.gmailThreadId!, from: b.toEmail, subject: 'Automatic reply: x', body: 'Away', headers: { 'auto-submitted': 'auto-replied' } });
  await fakeIncoming({ mailbox: x.email, threadId: c.gmailThreadId!, from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', body: 'Address not found' });
  await fakeIncoming({ mailbox: x.email, from: 'bank@bank.example', subject: 'Your code', body: '123456' });
  assert.equal(await syncMailbox(x.s.id), 7);
  assert.equal(await syncMailbox(x.s.id), 0, 'repeating finds nothing new');
  assert.ok((await get(a.id)).repliedAt);
  assert.equal((await get(b.id)).repliedAt, null);
  assert.equal((await get(c.id)).status, 'BOUNCED');
  const kinds = (await db.thread.findMany({ where: { studentId: x.s.id, hasIncoming: true } })).map((t) => t.kind).sort();
  assert.deepEqual(kinds, ['AUTO_REPLY', 'BOUNCE', 'OTHER', 'PROFESSOR']);
});

test('inbox can be limited to professor conversations', async () => {
  (env() as any).INBOX_SCOPE = 'professors';
  const x = await ready(1);
  await syncMailbox(x.s.id);
  const e = await sendFirst(x);
  await fakeIncoming({ mailbox: x.email, from: 'bank@bank.example', subject: 'Your code', body: '123456' });
  await fakeIncoming({ mailbox: x.email, from: `P <${e.toEmail}>`, subject: 'About your email', body: 'A new conversation, known by the address.' });
  await syncMailbox(x.s.id);
  const t = await db.thread.findMany({ where: { studentId: x.s.id, hasIncoming: true } });
  assert.deepEqual(t.map((y) => y.kind), ['PROFESSOR']);
});

test('the student’s private sent mail is not stored', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  await db.fakeMail.create({ data: { mailbox: x.email, threadId: 'private', labels: ['SENT'], headers: { from: x.email, to: 'mum@example.test', subject: 'hi' }, body: 'private' } });
  await syncMailbox(x.s.id);
  assert.equal(await db.message.count({ where: { studentId: x.s.id } }), 0);
});

test('Gmail forgot the sync point: mail is still found, once', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  await fakeIncoming({ mailbox: x.email, from: 'a@b.example', subject: 's', body: 'b' });
  fakeHooks.before = (op) => {
    if (op === 'changes') throw new MailError('NOT_FOUND', 'history gone');
  };
  assert.equal(await syncMailbox(x.s.id), 1);
  fakeHooks.before = undefined;
  assert.equal(await syncMailbox(x.s.id), 0);
});

test('a failure half way through reading does not lose mail', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  for (let i = 0; i < 3; i++) await fakeIncoming({ mailbox: x.email, from: 'a@b.example', subject: `s${i}`, body: 'b' });
  let calls = 0;
  fakeHooks.before = (op) => {
    if (op === 'getMessage' && ++calls === 2) throw new MailError('TRANSIENT', 'down');
  };
  await syncMailbox(x.s.id);
  fakeHooks.before = undefined;
  await syncMailbox(x.s.id);
  assert.equal(await db.message.count({ where: { studentId: x.s.id } }), 3);
});

test('a professor who already wrote is not sent the first email', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await fakeIncoming({ mailbox: x.email, from: e.toEmail, subject: 'Hello', body: 'I heard about you.' });
  await syncMailbox(x.s.id);
  const after = await sendFirst(x);
  assert.equal(after.status, 'CANCELLED');
  assert.equal(await sentMails(x.email), 0);
});

test('many bounces pause the campaign', async () => {
  const x = await ready(6);
  await syncMailbox(x.s.id);
  for (let i = 0; i < 4; i++) {
    const e = await sendFirst(x);
    await noGap(x.s.id);
    await fakeIncoming({ mailbox: x.email, threadId: e.gmailThreadId!, from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', body: 'no' });
  }
  await syncMailbox(x.s.id);
  const c = await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } });
  assert.equal(c.paused, true);
  await due(x.c.id);
  await sendDue();
  assert.equal(await sentMails(x.email), 4);
});

test('staff reply: in the same conversation, once, sandboxed', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  const e = await sendFirst(x);
  await fakeIncoming({ mailbox: x.email, threadId: e.gmailThreadId!, from: `P <${e.toEmail}>`, subject: 'Re: hello', body: 'More?' });
  await syncMailbox(x.s.id);
  const t = await db.thread.findFirstOrThrow({ where: { studentId: x.s.id, kind: 'PROFESSOR' } });
  const key = '11111111-1111-4111-8111-111111111111';
  const r = await Promise.allSettled([replyToThread(t.id, 'Thank you.', key, 'staff'), replyToThread(t.id, 'Thank you.', key, 'staff')]);
  assert.ok(r.some((y) => y.status === 'fulfilled'));
  assert.equal(await sentMails(x.email), 2); // the first email and one reply
  await replyToThread(t.id, 'Thank you.', key, 'staff'); // the second half of a double click
  assert.equal(await sentMails(x.email), 2);
  const out = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email, labels: { has: 'SENT' } }, orderBy: { seq: 'desc' } });
  assert.equal(out.threadId, e.gmailThreadId);
  assert.equal((out.headers as any).to, 'sandbox@example.test');
  assert.ok((out.headers as any)['in-reply-to']);
});

test('a refused reply can be tried again and arrives once', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  const e = await sendFirst(x);
  await fakeIncoming({ mailbox: x.email, threadId: e.gmailThreadId!, from: `P <${e.toEmail}>`, subject: 'Re: hello', body: 'More?' });
  await syncMailbox(x.s.id);
  const t = await db.thread.findFirstOrThrow({ where: { studentId: x.s.id, kind: 'PROFESSOR' } });
  const key = '22222222-2222-4222-8222-222222222222';
  fakeHooks.before = (op) => {
    if (op === 'sendDraft') throw new MailError('RATE', '429');
  };
  await assert.rejects(replyToThread(t.id, 'First words.', key, 'staff'), C.UserError);
  fakeHooks.before = undefined;
  await replyToThread(t.id, 'Better words.', key, 'staff');
  const sent = await db.fakeMail.findMany({ where: { mailbox: x.email, labels: { has: 'SENT' } }, orderBy: { seq: 'asc' } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, 'Better words.');
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 0);
});

test('an unconfirmed reply is not sent again by pressing Send', async () => {
  const x = await ready(1);
  await syncMailbox(x.s.id);
  const e = await sendFirst(x);
  await fakeIncoming({ mailbox: x.email, threadId: e.gmailThreadId!, from: `P <${e.toEmail}>`, subject: 'Re: hello', body: 'More?' });
  await syncMailbox(x.s.id);
  const t = await db.thread.findFirstOrThrow({ where: { studentId: x.s.id, kind: 'PROFESSOR' } });
  const key = '33333333-3333-4333-8333-333333333333';
  fakeHooks.after = (op) => {
    if (op === 'sendDraft') throw new MailError('TRANSIENT', 'timeout');
  };
  await assert.rejects(replyToThread(t.id, 'Hello.', key, 'staff'), C.UserError);
  fakeHooks.after = undefined;
  await assert.rejects(replyToThread(t.id, 'Hello.', key, 'staff'), C.UserError);
  assert.equal(await sentMails(x.email), 2);
});

test('cancel removes the Gmail draft; campaign finishes', async () => {
  const x = await ready(2);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await pushDrafts();
  const [a] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await C.cancelEmail(a.id, 'staff');
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email } }), 1);
  await sendFirst(x);
  await C.completeFinished();
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).status, 'COMPLETED');
});

test('turning the sandbox address changes old drafts before they are sent', async () => {
  const x = await ready(1);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await pushDrafts();
  (env() as any).EMAIL_SANDBOX_TO = 'other-sandbox@example.test';
  const e = await sendFirst(x);
  assert.equal(e.status, 'SENT');
  assert.equal(e.sentTo, 'other-sandbox@example.test');
});

test('new schedule moves unsent emails and keeps the sent ones', async () => {
  const x = await ready(4);
  const e = await sendFirst(x);
  const start = DateTime.now().setZone('Asia/Dhaka').plus({ days: 10 }).toISODate()!;
  await C.changeSchedule(x.c.id, { startDate: start, minPerDay: 1, maxPerDay: 1, ...ALWAYS }, 'staff');
  const rest = await db.email.findMany({ where: { campaignId: x.c.id, status: 'SCHEDULED' } });
  assert.equal(new Set(rest.map((r) => DateTime.fromJSDate(r.scheduledFor!).setZone('Asia/Dhaka').toISODate())).size, 3);
  assert.equal((await get(e.id)).status, 'SENT');
});

test('two workers writing at once never write the same email twice', async () => {
  const x = await ready(20, { approve: false });
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { status: 'PENDING', contentVersion: 1 } });
  await Promise.all(Array.from({ length: 6 }, async () => { while (await draftNext()); }));
  const all = await db.email.findMany({ where: { campaignId: x.c.id } });
  assert.ok(all.every((e) => e.status === 'DRAFT' && e.contentVersion === 2));
});

test('writing all again goes back to review and changes the same Gmail drafts', async () => {
  const x = await ready(3);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  while (await pushDrafts());
  const before = (await db.email.findMany({ where: { campaignId: x.c.id } })).map((e) => e.gmailDraftId).sort();
  await db.student.update({ where: { id: x.s.id }, data: { notes: `Plays chess. ${x.s.notes}` } });
  assert.equal(await C.rewriteAll(x.c.id, 'staff'), 3);
  await sendDue();
  assert.equal(await sentMails(x.email), 0);
  while (await draftNext());
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).status, 'REVIEW');
  await C.approveCampaign(x.c.id, 'staff');
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  while (await pushDrafts());
  assert.deepEqual((await db.email.findMany({ where: { campaignId: x.c.id } })).map((e) => e.gmailDraftId).sort(), before);
  const drafts = await db.fakeMail.findMany({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } });
  assert.equal(drafts.length, 3);
  assert.ok(drafts.every((d) => d.body.includes('chess')));
});

test('test send leaves outside the window, once, only to the test inbox, only in test mode', async () => {
  const x = await ready(2);
  const now = DateTime.now().setZone('Asia/Dhaka');
  await db.campaign.update({ where: { id: x.c.id }, data: { weekdays: [(now.weekday % 7) + 1] } });
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await C.sendTestNow(e.id, 'staff');
  await moveLate();
  await sendDue();
  await sendDue();
  assert.equal((await get(e.id)).status, 'SENT');
  assert.equal((await get(e.id)).sentTo, 'sandbox@example.test');
  assert.equal(await sentMails(x.email), 1);
  const [f] = await db.email.findMany({ where: { campaignId: x.c.id, status: 'SCHEDULED' } });
  (env() as any).EMAIL_SANDBOX = false;
  await db.campaign.update({ where: { id: x.c.id }, data: { live: true } });
  await assert.rejects(C.sendTestNow(f.id, 'staff'), C.UserError);
  (env() as any).EMAIL_SANDBOX = true;
});

test('real Gmail with the example test inbox sends and drafts nothing', async () => {
  const x = await ready(1);
  (env() as any).EMAIL_TRANSPORT = 'gmail';
  await due(x.c.id);
  assert.equal(await pushDrafts(), 0);
  assert.equal(await sendDue(), 0);
  (env() as any).EMAIL_TRANSPORT = 'fake';
});

test('best matches are sent first', async () => {
  const x = await ready(4, { approve: false });
  const all = await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { professor: { rowNumber: 'asc' } } });
  for (const [i, fit] of ['weak', 'unknown', 'strong', 'some'].entries()) await db.email.update({ where: { id: all[i].id }, data: { fit } });
  await C.approveCampaign(x.c.id, 'staff');
  const order = (await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { scheduledFor: 'asc' } })).map((e) => e.fit);
  assert.deepEqual(order, ['strong', 'some', 'unknown', 'weak']);
});

test('a personal professor address is on hold until a person checked it', async () => {
  const x = await ready(1, { approve: false });
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await db.email.update({ where: { id: e.id }, data: { toEmail: 'prof@gmail.com', status: 'PENDING' } });
  while (await draftNext());
  await assert.rejects(C.approveCampaign(x.c.id, 'staff'), C.UserError);
  await C.acceptFlags(e.id, 'staff');
  assert.equal(await C.approveCampaign(x.c.id, 'staff'), 1);
});

test('no phone, no campaign', async () => {
  const x = await ready(1);
  await db.student.update({ where: { id: x.s.id }, data: { phone: null } });
  await assert.rejects(C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'x', startDate: today(), minPerDay: 1, maxPerDay: 2, ...ALWAYS }, 's'), /phone/);
});

test('row by row: each professor is written, scheduled and in Gmail before the next one starts', async () => {
  const x = await ready(6, { auto: true, wait: true });
  for (let row = 1; row <= 6; row++) {
    await draftNext();
    const all = await db.email.findMany({ where: { campaignId: x.c.id }, include: { professor: true }, orderBy: { professor: { rowNumber: 'asc' } } });
    assert.deepEqual(all.map((e) => e.status), [...Array(row).fill('SCHEDULED'), ...Array(6 - row).fill('PENDING')]);
    assert.ok(all.slice(0, row).every((e) => e.gmailDraftId && e.scheduledFor && e.scheduledFor > new Date() && e.step === null && e.claimToken === null));
  }
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 6);
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).status, 'ACTIVE');
  assert.equal(await sentMails(x.email), 0);
  const [e] = await due(x.c.id, 1);
  await sendDue(1);
  assert.equal((await get(e.id)).status, 'SENT');
});

test('250 rows one by one: never more than the daily maximum, spaced, best 15 to 20 a day', async () => {
  const x = await ready(250, { auto: true });
  const rows = await db.email.findMany({ where: { campaignId: x.c.id, status: 'SCHEDULED' }, orderBy: { scheduledFor: 'asc' } });
  assert.equal(rows.length, 250);
  const days = new Map<string, number[]>();
  for (const r of rows) {
    const k = DateTime.fromJSDate(r.scheduledFor!).setZone('Asia/Dhaka').toISODate()!;
    days.set(k, [...(days.get(k) ?? []), r.scheduledFor!.getTime()]);
  }
  for (const t of days.values()) {
    assert.ok(t.length <= 20);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 60_000, `${(t[i] - t[i - 1]) / 1000}s apart`);
  }
});

test('a held email does not stop the rows after it', async () => {
  const x = await ready(3, { auto: true, wait: true });
  const [, second] = await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { professor: { rowNumber: 'asc' } } });
  await db.email.update({ where: { id: second.id }, data: { toEmail: 'someone@gmail.com' } });
  while (await draftNext());
  const all = await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { professor: { rowNumber: 'asc' } } });
  assert.deepEqual(all.map((e) => e.status), ['SCHEDULED', 'DRAFT', 'SCHEDULED']);
});

test('two students take turns, row by row', async () => {
  const x = await ready(3, { auto: true, wait: true });
  const y = await ready(3, { auto: true, wait: true });
  for (let i = 0; i < 4; i++) await draftNext();
  const n = (id: string) => db.email.count({ where: { campaignId: id, status: 'SCHEDULED' } });
  assert.deepEqual([await n(x.c.id), await n(y.c.id)], [2, 2]);
});

test('pause stops writing too; resume goes on with the next row', async () => {
  const x = await ready(3, { auto: true, wait: true });
  await draftNext();
  await C.setPaused(x.c.id, true, 'staff');
  assert.equal(await draftNext(), false);
  await C.setPaused(x.c.id, false, 'staff');
  while (await draftNext());
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 3);
});

test('stopped sending: rows are still written and scheduled, but nothing is put into Gmail until it resumes', async () => {
  const x = await ready(2, { auto: true, wait: true });
  await db.setting.create({ data: { key: 'outreachPaused', value: true } });
  while (await draftNext());
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email } }), 0);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 2);
  await db.setting.delete({ where: { key: 'outreachPaused' } });
  while (await pushDrafts());
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 2);
});

test('cancel: nothing more is written or sent, drafts leave Gmail, sent ones stay, professors are free again', async () => {
  const x = await ready(5, { auto: true, wait: true });
  for (let i = 0; i < 3; i++) await draftNext();
  const [first] = await due(x.c.id, 1);
  await sendDue(1);
  await db.email.update({ where: { id: first.id }, data: { sandboxed: false } }); // as if really sent
  assert.equal(await C.cancelCampaign(x.c.id, 'staff'), 4);
  assert.equal(await draftNext(), false);
  await due(x.c.id);
  await sendDue();
  assert.equal(await sentMails(x.email), 1);
  while (await cleanUpCancelled());
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 0);
  assert.equal((await get(first.id)).status, 'SENT');
  const again = await C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'again', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS }, 'staff');
  assert.equal(await db.email.count({ where: { campaignId: again.id } }), 4, 'all but the one that was really sent');
  while (await draftNext());
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 4);
});

test('cancel while the writer is in the middle of an email: its result is ignored', async () => {
  const x = await ready(1, { auto: true, wait: true });
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  const working = draftNext();
  for (let i = 0; i < 200 && (await get(e.id)).status !== 'GENERATING'; i++) await new Promise((r) => setTimeout(r, 2));
  await C.cancelCampaign(x.c.id, 'staff').catch(() => undefined);
  await working;
  const after = await get(e.id);
  assert.equal(after.status, 'CANCELLED');
  while (await cleanUpCancelled());
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email } }), 0);
});

test('a cancelled draft the student already sent by hand counts as sent', async () => {
  const x = await ready(1, { auto: true });
  const d = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } });
  await C.cancelCampaign(x.c.id, 'staff');
  await db.fakeMail.delete({ where: { id: d.id } });
  await db.fakeMail.create({ data: { mailbox: x.email, threadId: d.threadId, labels: ['SENT'], headers: d.headers as any, body: d.body } });
  await cleanUpCancelled();
  assert.equal((await db.email.findFirstOrThrow({ where: { campaignId: x.c.id } })).status, 'SENT');
});

test('the Profile is read in batches into a brief, and the emails use it', async () => {
  const x = await ready(1, { wait: true });
  await C.cancelCampaign(x.c.id, 's');
  await db.student.update({ where: { id: x.s.id }, data: { notes: null } });
  const line = (n: number) => `The thesis project number ${n} studied asphalt mixtures with recycled plastic in a careful laboratory programme of many months.`;
  const text = ['Date of birth: 1 January 1999', 'Passport: A0123', 'Email: someone@example.test', 'BSc in Civil Engineering, CGPA 3.61 of 4.00.', 'Proposed research question: how does plastic change fatigue life?', ...Array.from({ length: 180 }, (_, i) => line(i))].join('\n');
  const p = await db.studentProfile.create({ data: { studentId: x.s.id, version: 1, fileName: 'p.pdf', sizeBytes: 1, content: new Uint8Array(1), text } });
  const again = { studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'p', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS };
  await assert.rejects(C.createCampaign(again, 's'), /still being read/);
  let steps = 0;
  while (await profileNext()) steps++;
  assert.ok(steps >= 4, `${steps} steps`);
  const r = await db.studentProfile.findUniqueOrThrow({ where: { id: p.id } });
  assert.equal(r.status, 'READY');
  assert.match(r.brief!, /CGPA 3\.61/);
  assert.match(r.brief!, /fatigue life/);
  assert.doesNotMatch(r.brief!, /Passport|birth|someone@/);
  const c = await C.createCampaign(again, 's');
  while (await draftNext());
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(e.status, 'SCHEDULED');
  assert.match(e.body, /Civil Engineering|fatigue life/);
});

test('real students need consent before the Profile is read', async () => {
  const s = await db.student.create({ data: { fullName: 'R', email: 'real2@gmail.com' } });
  const p = await db.studentProfile.create({ data: { studentId: s.id, version: 1, fileName: 'p', sizeBytes: 1, content: new Uint8Array(1), text: 'x '.repeat(400) } });
  await profileNext();
  const r = await db.studentProfile.findUniqueOrThrow({ where: { id: p.id } });
  assert.equal(r.status, 'FAILED');
  assert.match(r.error!, /consent/);
});

const trash = async (where: any) => {
  // what Gmail really does with a deleted draft: it stays, in the Trash
  for (const d of await db.fakeMail.findMany({ where: { ...where, labels: { has: 'DRAFT' } } })) await db.fakeMail.update({ where: { id: d.id }, data: { labels: ['DRAFT', 'TRASH'] } });
};
const inDrafts = (mailbox: string) => db.fakeMail.count({ where: { mailbox, labels: { has: 'DRAFT' }, NOT: { labels: { has: 'TRASH' } } } });
const old = (campaignId: string) => db.email.updateMany({ where: { campaignId }, data: { draftedAt: new Date(Date.now() - 5 * 60_000) } });

test('a draft deleted in Gmail cancels the email here; the others stay; it can come back', async () => {
  const x = await ready(3, { auto: true });
  await old(x.c.id);
  const [a] = await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { professor: { rowNumber: 'asc' } } });
  await trash({ draftId: a.gmailDraftId });
  await syncMailbox(x.s.id); // first contact with the mailbox
  await syncMailbox(x.s.id);
  const e = await get(a.id);
  assert.equal(e.status, 'CANCELLED');
  assert.equal(e.gmailDraftId, null);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 2);
  await C.restoreEmail(a.id, 'staff');
  assert.equal(await C.scheduleReady(), 1);
  while (await pushDrafts());
  assert.equal((await get(a.id)).status, 'SCHEDULED');
  assert.equal(await inDrafts(x.email), 3);
});

test('a deleted draft frees the professor for a new campaign', async () => {
  const x = await ready(2, { auto: true });
  await old(x.c.id);
  await trash({ mailbox: x.email });
  assert.equal(await noticeDeletedDrafts(x.s.id), 2);
  const c = await C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'n', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS }, 's');
  assert.equal(await db.email.count({ where: { campaignId: c.id } }), 2);
});

test('a draft that is gone because it was sent is not taken for deleted', async () => {
  const x = await ready(1, { auto: true });
  await old(x.c.id);
  const d = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } });
  await db.fakeMail.delete({ where: { id: d.id } });
  await db.fakeMail.create({ data: { mailbox: x.email, threadId: d.threadId, labels: ['SENT'], headers: d.headers as any, body: d.body } });
  assert.equal(await noticeDeletedDrafts(x.s.id), 0);
  assert.equal((await db.email.findFirstOrThrow({ where: { campaignId: x.c.id } })).status, 'SENT');
});

test('trouble with Gmail, a fresh draft or an email being worked on is never taken for deleted', async () => {
  const x = await ready(2, { auto: true });
  await db.fakeMail.deleteMany({ where: { mailbox: x.email } });
  assert.equal(await noticeDeletedDrafts(x.s.id), 0, 'made a moment ago');
  await old(x.c.id);
  fakeHooks.before = (op) => {
    if (op === 'listDrafts') throw new MailError('TRANSIENT', 'down');
  };
  await syncMailbox(x.s.id);
  await syncMailbox(x.s.id);
  fakeHooks.before = undefined;
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { claimToken: 'x', claimedAt: new Date() } });
  assert.equal(await noticeDeletedDrafts(x.s.id), 0);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 2);
});

test('replace: unsent emails move to the new campaign and keep their one Gmail draft; sent ones stay', async () => {
  const x = await ready(4, { auto: true });
  const [first] = await due(x.c.id, 1);
  await sendDue(1);
  const p = { studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'again', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS };
  await db.email.update({ where: { id: first.id }, data: { sandboxed: false } }); // as if really sent
  await assert.rejects(C.createCampaign(p, 's'), /1 sent, 3 not sent yet.*Replace/);
  const drafts = (await db.email.findMany({ where: { campaignId: x.c.id, gmailDraftId: { not: null } } })).map((e) => e.gmailDraftId).sort();
  const c = await C.createCampaign({ ...p, replace: true }, 's');
  assert.equal(await db.email.count({ where: { campaignId: c.id, status: 'PENDING' } }), 3);
  assert.equal((await get(first.id)).campaignId, x.c.id);
  while (await draftNext());
  while (await pushDrafts());
  const now = await db.email.findMany({ where: { campaignId: c.id } });
  assert.ok(now.every((e) => e.status === 'SCHEDULED'));
  assert.deepEqual(now.map((e) => e.gmailDraftId).sort(), drafts);
  assert.equal(await db.fakeMail.count({ where: { mailbox: x.email, labels: { has: 'DRAFT' } } }), 3);
  assert.equal(await sentMails(x.email), 1);
});

test('replacing all of an old campaign closes it', async () => {
  const x = await ready(2, { auto: true });
  await C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'n', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS, replace: true }, 's');
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).status, 'CANCELLED');
});

test('automatic: an email corrected by staff gets its time by itself; off means it waits', async () => {
  const x = await ready(2, { auto: true, wait: true });
  const [a] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await db.email.update({ where: { id: a.id }, data: { toEmail: 'p@gmail.com' } });
  while (await draftNext());
  assert.equal(await C.scheduleReady(), 0, 'still held');
  await C.acceptFlags(a.id, 'staff');
  await C.setAutoSchedule(x.c.id, false, 'staff');
  assert.equal(await C.scheduleReady(), 0);
  await C.setAutoSchedule(x.c.id, true, 'staff');
  assert.equal(await C.scheduleReady(), 1);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 2);
});

test('turning automatic on schedules what was waiting for approval', async () => {
  const x = await ready(3, { approve: false });
  assert.equal(await C.scheduleReady(), 0);
  await C.setAutoSchedule(x.c.id, true, 'staff');
  assert.equal(await C.scheduleReady(), 3);
});

test('a draft in the Trash is never sent, even when its time comes before anybody noticed', async () => {
  const x = await ready(2, { auto: true });
  await trash({ mailbox: x.email });
  await due(x.c.id);
  for (let i = 0; i < 4; i++) {
    await sendDue();
    await noGap(x.s.id);
  }
  assert.equal(await sentMails(x.email), 0);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { claimedAt: new Date(Date.now() - 6 * 60_000) } });
  await recoverStuck();
  assert.equal(await sentMails(x.email), 0);
});

test('an edit does not change a draft inside the Trash', async () => {
  const x = await ready(1, { auto: true });
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  await trash({ mailbox: x.email });
  const before = await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } });
  const e = await db.email.findFirstOrThrow({ where: { campaignId: x.c.id } });
  await C.editEmail(e.id, { subject: e.subject, body: e.body.replace('I have attached my CV.', 'I have attached my CV today.') }, 'staff');
  await pushDrafts();
  assert.equal((await db.fakeMail.findFirstOrThrow({ where: { mailbox: x.email } })).body, before.body);
});

test('drafts deleted in Gmail and then written again with replace: new drafts are made', async () => {
  const x = await ready(2, { auto: true });
  await trash({ mailbox: x.email });
  const c = await C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'n', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS, replace: true }, 's');
  await old(c.id);
  await noticeDeletedDrafts(x.s.id);
  while (await draftNext());
  while (await pushDrafts());
  const all = await db.email.findMany({ where: { campaignId: c.id } });
  assert.deepEqual(all.map((e) => e.status), ['SCHEDULED', 'SCHEDULED']);
  assert.equal(await inDrafts(x.email), 2);
});

test('cancelling after the student deleted the draft leaves nothing behind', async () => {
  const x = await ready(1, { auto: true });
  await trash({ mailbox: x.email });
  await C.cancelCampaign(x.c.id, 'staff');
  while (await cleanUpCancelled());
  const e = await db.email.findFirstOrThrow({ where: { campaignId: x.c.id } });
  assert.deepEqual([e.status, e.gmailDraftId], ['CANCELLED', null]);
  assert.equal(await sentMails(x.email), 0);
});

test('deleted in Gmail and replaced at once, before any mail check: written, scheduled, new drafts', async () => {
  const x = await ready(2, { auto: true });
  await old(x.c.id);
  await trash({ mailbox: x.email });
  const c = await C.createCampaign({ studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'n', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS, replace: true }, 's');
  while (await draftNext());
  while (await pushDrafts());
  await old(c.id);
  assert.equal(await noticeDeletedDrafts(x.s.id), 0);
  const all = await db.email.findMany({ where: { campaignId: c.id } });
  assert.deepEqual(all.map((e) => e.status), ['SCHEDULED', 'SCHEDULED']);
  assert.equal(await inDrafts(x.email), 2);
  await due(c.id, 1);
  await sendDue(1);
  assert.equal(await sentMails(x.email), 1);
});

test('test mode: an own test address gets its email itself, the professor next to it does not', async () => {
  const x = await ready(2, { auto: true, wait: true });
  const [a, b] = await db.email.findMany({ where: { campaignId: x.c.id }, orderBy: { professor: { rowNumber: 'asc' } } });
  await db.email.update({ where: { id: a.id }, data: { toEmail: 'own.tester@gmail.com' } });
  (env() as any).EMAIL_SANDBOX_ALLOW = 'own.tester@gmail.com';
  while (await draftNext());
  for (let i = 0; i < 3; i++) {
    await due(x.c.id);
    await sendDue();
    await noGap(x.s.id);
  }
  assert.deepEqual([(await get(a.id)).sentTo, (await get(b.id)).sentTo], ['own.tester@gmail.com', 'sandbox@example.test']);
  const subjects = (await db.fakeMail.findMany({ where: { mailbox: x.email, labels: { has: 'SENT' } } })).map((m) => (m.headers as any).subject);
  assert.ok(subjects.some((s) => s.startsWith('[TEST] Prospective')) && subjects.some((s) => s.startsWith('[SANDBOX to')));
});

test('a Gmail address that is not on the list is still on hold', async () => {
  const x = await ready(1, { auto: true, wait: true });
  const [a] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await db.email.update({ where: { id: a.id }, data: { toEmail: 'somebody@gmail.com' } });
  (env() as any).EMAIL_SANDBOX_ALLOW = 'own.tester@gmail.com';
  while (await draftNext());
  assert.equal((await get(a.id)).status, 'DRAFT');
});

const consent = (id: string) => db.student.update({ where: { id }, data: { consentAt: new Date(), consentBy: 's' } });
const recipients = async (mailbox: string) => (await db.fakeMail.findMany({ where: { mailbox, labels: { has: 'SENT' } }, orderBy: { seq: 'asc' } })).map((m) => [(m.headers as any).to, (m.headers as any).subject.slice(0, 12)]);
async function sendAll(x: Awaited<ReturnType<typeof ready>>, campaignId = x.c.id) {
  for (let i = 0; i < 6; i++) {
    await due(campaignId);
    await sendDue();
    await noGap(x.s.id);
  }
}

test('LIVE: the real address, the plain subject, only for that campaign', async () => {
  const x = await ready(1, { auto: true });
  const y = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await sendAll(x);
  await sendAll(y);
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  assert.deepEqual(await recipients(x.email), [[e.toEmail, 'Prospective ']]);
  assert.equal(e.sandboxed, false);
  assert.deepEqual(await recipients(y.email), [['sandbox@example.test', '[SANDBOX to ']]);
});

test('the master switch wins: LIVE campaigns go to the test inbox while the sandbox is on', async () => {
  const x = await ready(1, { auto: true });
  await db.campaign.update({ where: { id: x.c.id }, data: { live: true } });
  await sendAll(x);
  assert.equal((await recipients(x.email))[0][0], 'sandbox@example.test');
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /switched off/);
});

test('LIVE needs consent, a connected Gmail and an open campaign', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /consent/);
  await consent(x.s.id);
  await db.mailbox.update({ where: { studentId: x.s.id }, data: { status: 'RECONNECT' } });
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /Connect/);
  await db.mailbox.update({ where: { studentId: x.s.id }, data: { status: 'CONNECTED' } });
  await C.cancelCampaign(x.c.id, 'staff');
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /closed/);
});

test('drafts already in Gmail are re-addressed when LIVE is switched on, and back when it is switched off', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX_ALLOW = undefined;
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { scheduledFor: new Date(Date.now() + 3600_000) } });
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  const head = async () => (await db.fakeMail.findFirstOrThrow({ where: { draftId: e.gmailDraftId } })).headers as any;
  await C.setLive(x.c.id, true, 'staff');
  await pushDrafts();
  assert.deepEqual([(await head()).to, (await head()).subject.startsWith('Prospective')], [e.toEmail, true]);
  await C.setLive(x.c.id, false, 'staff');
  await pushDrafts();
  assert.deepEqual([(await head()).to, (await head()).subject.startsWith('[SANDBOX')], ['sandbox@example.test', true]);
});

test('an own address loses its [TEST] mark when LIVE is switched on', async () => {
  const x = await ready(1, { auto: true, wait: true });
  (env() as any).EMAIL_SANDBOX_ALLOW = 'own.tester@gmail.com';
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { toEmail: 'own.tester@gmail.com' } });
  while (await draftNext());
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await sendAll(x);
  assert.deepEqual(await recipients(x.email), [['own.tester@gmail.com', 'Prospective ']]);
});

test('switched back to test mode in the last moment: nothing goes to the professor', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await pushDrafts();
  let first = true;
  fakeHooks.before = async (op) => {
    if (op === 'draftRecipient' && first) {
      first = false;
      await C.setLive(x.c.id, false, 'staff');
    }
  };
  await sendAll(x);
  fakeHooks.before = undefined;
  assert.ok((await recipients(x.email)).every(([to]) => to === 'sandbox@example.test'), JSON.stringify(await recipients(x.email)));
});

test('the last defence refuses a real address that does not come from a LIVE campaign', async () => {
  const { mail } = await import('../../src/lib/mail');
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  const m = { to: 'prof@uni.example.test', subject: 's', body: 'b' };
  assert.throws(() => mail().createDraft(x.s.id, m), /Sandbox/);
  await mail().createDraft(x.s.id, { ...m, live: true });
  (env() as any).EMAIL_SANDBOX = true;
  assert.throws(() => mail().createDraft(x.s.id, { ...m, live: true }), /Sandbox/);
});

test('test sends do not use an address up; real ones do, for ever', async () => {
  const x = await ready(2, { auto: true });
  await sendAll(x);
  assert.equal(await sentMails(x.email), 2);
  const p = { studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'again', startDate: today(), minPerDay: 20, maxPerDay: 20, ...ALWAYS };
  (env() as any).EMAIL_SANDBOX = false;
  await assert.rejects(C.createCampaign({ ...p, live: true }, 's'), /consent/);
  await consent(x.s.id);
  const c = await C.createCampaign({ ...p, live: true }, 's');
  while (await draftNext());
  await sendAll(x, c.id);
  assert.equal(await db.email.count({ where: { campaignId: c.id, status: 'SENT', sandboxed: false } }), 2);
  await assert.rejects(C.createCampaign({ ...p, replace: true }, 's'), /2 sent/);
});

test('answers: to the real person in a LIVE conversation, otherwise to the test inbox', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await syncMailbox(x.s.id);
  await sendAll(x);
  const [e] = await db.email.findMany({ where: { campaignId: x.c.id } });
  await fakeIncoming({ mailbox: x.email, threadId: e.gmailThreadId!, from: `P <${e.toEmail}>`, subject: 'Re: hello', body: 'More?' });
  await syncMailbox(x.s.id);
  const t = await db.thread.findFirstOrThrow({ where: { studentId: x.s.id, kind: 'PROFESSOR' } });
  await replyToThread(t.id, 'Thank you.', '44444444-4444-4444-8444-444444444444', 'staff');
  assert.equal((await recipients(x.email)).at(-1)![0], e.toEmail);
  await C.setLive(x.c.id, false, 'staff');
  await replyToThread(t.id, 'Test.', '55555555-5555-4555-8555-555555555555', 'staff');
  assert.equal((await recipients(x.email)).at(-1)![0], 'sandbox@example.test');
});

test('the master switch is flipped in .env: a ready [TEST] draft loses its mark before it is sent', async () => {
  const x = await ready(1, { auto: true, wait: true });
  (env() as any).EMAIL_SANDBOX_ALLOW = 'own.tester2@gmail.com';
  await db.email.updateMany({ where: { campaignId: x.c.id }, data: { toEmail: 'own.tester2@gmail.com' } });
  await db.campaign.update({ where: { id: x.c.id }, data: { live: true } });
  while (await draftNext());
  (env() as any).EMAIL_SANDBOX = false;
  await sendAll(x);
  assert.deepEqual(await recipients(x.email), [['own.tester2@gmail.com', 'Prospective ']]);
});

test('consent withdrawn: LIVE ends and nothing goes to the professor', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await C.endLive(x.s.id, 'staff');
  await sendAll(x);
  assert.equal((await recipients(x.email))[0][0], 'sandbox@example.test');
});

test('slow start: a LIVE campaign of 10 sends 3 on its first day, test mode is not slowed, staff can turn it off', async () => {
  const x = await ready(10, { auto: true });
  const perDay = async () => (await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "Email" WHERE "campaignId" = ${x.c.id} AND "scheduledFor" IS NOT NULL GROUP BY ("scheduledFor" AT TIME ZONE 'Asia/Dhaka')::date ORDER BY ("scheduledFor" AT TIME ZONE 'Asia/Dhaka')::date`).map((r) => Number(r.n));
  assert.ok(Math.max(...(await perDay())) > 3);
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  // today's window may be nearly over, so the first full day can be tomorrow: two days of three are certain, five is the most after that
  const n = await perDay();
  assert.ok(n.slice(0, 2).every((k) => k <= 3) && n.every((k) => k <= 5), JSON.stringify(n));
  await sendAll(x); // everything is made due at once: the sender itself must keep to three
  assert.equal(await sentMails(x.email), 3);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SCHEDULED' } }), 7, 'the others wait');
  await C.setSlowStart(x.c.id, false, 'staff');
  await sendAll(x);
  await sendAll(x);
  assert.equal(await sentMails(x.email), 10);
});

test('a Gmail without history: LIVE is refused for professors, allowed for own test addresses, and asked again later', async () => {
  const x = await ready(2, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  fakeHooks.oldMessages = 19;
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /too new.*only 19 messages/);
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } })).live, false);
  const p = { studentId: x.s.id, listId: x.list.id, cvId: x.cv.id, name: 'again', startDate: today(), minPerDay: 20, maxPerDay: 20, replace: true, live: true, ...ALWAYS };
  await assert.rejects(C.createCampaign(p, 's'), /too new/);
  assert.equal(await db.campaign.count({ where: { studentId: x.s.id } }), 1);
  const [a] = await db.email.findMany({ where: { campaignId: x.c.id } });
  (env() as any).EMAIL_SANDBOX_ALLOW = 'own.tester3@gmail.com';
  await db.email.update({ where: { id: a.id }, data: { toEmail: 'own.tester3@gmail.com' } });
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /too new/, 'one professor among them');
  await db.email.updateMany({ where: { campaignId: x.c.id, id: { not: a.id } }, data: { status: 'CANCELLED' } });
  await C.setLive(x.c.id, true, 'staff');
  await sendAll(x);
  assert.deepEqual(await recipients(x.email), [['own.tester3@gmail.com', 'Prospective ']]);
});

test('a Gmail with history is asked once; when Gmail does not answer, LIVE waits', async () => {
  const x = await ready(1, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  const { MailError } = await import('../../src/lib/mail');
  let asked = 0;
  fakeHooks.before = (op) => {
    if (op === 'oldMessages' && ++asked === 1) throw new MailError('TRANSIENT', 'no network');
  };
  await assert.rejects(C.setLive(x.c.id, true, 'staff'), /could not be asked/);
  await C.setLive(x.c.id, true, 'staff');
  await sendAll(x);
  assert.equal(asked, 2);
  assert.equal(await sentMails(x.email), 1);
});

test('a campaign that is LIVE already stops when the account is too new: nothing is sent, the reason is shown', async () => {
  const x = await ready(2, { auto: true });
  (env() as any).EMAIL_SANDBOX = false;
  await consent(x.s.id);
  await C.setLive(x.c.id, true, 'staff');
  await db.mailbox.update({ where: { studentId: x.s.id }, data: { oldMessages: null, ageCheckedAt: null } }); // LIVE since before this check existed
  fakeHooks.oldMessages = 0;
  await sendAll(x);
  const c = await db.campaign.findUniqueOrThrow({ where: { id: x.c.id } });
  assert.deepEqual([await sentMails(x.email), c.paused, /too new/.test(c.pauseReason ?? '')], [0, true, true]);
  assert.equal(await db.email.count({ where: { campaignId: x.c.id, status: 'SENDING' } }), 0);
  fakeHooks.oldMessages = 20; // weeks later
  await db.mailbox.update({ where: { studentId: x.s.id }, data: { ageCheckedAt: new Date(Date.now() - 2 * 3600_000) } });
  await C.setPaused(x.c.id, false, 'staff');
  await sendAll(x);
  assert.equal(await sentMails(x.email), 2);
});

test('test mode is never stopped by the age of the account', async () => {
  const x = await ready(1, { auto: true });
  fakeHooks.oldMessages = 0;
  await sendAll(x);
  assert.equal(await sentMails(x.email), 1);
});
