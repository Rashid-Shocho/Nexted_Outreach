import type { MessageKind } from '@prisma/client';
import { audit, db } from '../db';
import { env, sandboxMissing } from '../env';
import { mail, MailError, recipientFor, type InMessage } from '../mail';
import { addressOf, classify, nameOf } from '../mail/mime';
import { noteMailboxError } from './sender';
import { UserError } from './campaigns';

/** Reading students' mailboxes into the one shared inbox. */

const ids = (h: string | undefined) => h?.match(/<[^<>\s]+>/g) ?? [];
const STRENGTH: MessageKind[] = ['OTHER', 'AUTO_REPLY', 'BOUNCE', 'PROFESSOR'];

/** Which of our emails does this message belong to? Thread first, then reply headers, then sender. */
async function matchEmail(studentId: string, m: InMessage, outgoing: boolean) {
  const byThread = await db.email.findFirst({ where: { studentId, gmailThreadId: m.threadId } });
  if (byThread) return byThread;
  const refs = [...ids(m.headers['in-reply-to']), ...ids(m.headers['references'])];
  if (refs.length) {
    const parent = await db.message.findFirst({ where: { studentId, messageIdHeader: { in: refs }, thread: { emailId: { not: null } } }, select: { thread: { select: { emailId: true } } } });
    if (parent?.thread.emailId) return db.email.findUnique({ where: { id: parent.thread.emailId } });
  }
  if (outgoing) return null;
  const failed = m.headers['x-failed-recipients']?.trim().toLowerCase();
  if (failed) return db.email.findFirst({ where: { studentId, toEmail: failed, status: { in: ['SENT', 'BOUNCED'] } } });
  return db.email.findFirst({ where: { studentId, toEmail: addressOf(m.headers['from']), status: { notIn: ['CANCELLED'] } } });
}

/** Stores one message. Safe to repeat. Returns true when it was new. */
export async function ingest(studentId: string, mailbox: string, m: InMessage): Promise<boolean> {
  if (m.labels.some((l) => ['DRAFT', 'TRASH', 'CHAT'].includes(l))) return false;
  if (await db.message.findUnique({ where: { studentId_gmailMessageId: { studentId, gmailMessageId: m.id } }, select: { id: true } })) return false;

  const from = addressOf(m.headers['from']);
  const outgoing = m.labels.includes('SENT') || from === mailbox.toLowerCase();
  const email = await matchEmail(studentId, m, outgoing);
  const known = !!email;

  if (!known) {
    if (outgoing) {
      const stored = await db.thread.findUnique({ where: { studentId_gmailThreadId: { studentId, gmailThreadId: m.threadId } }, select: { id: true } });
      if (!stored) return false; // the student's own private mail
    } else if (env().INBOX_SCOPE === 'professors' || !m.labels.includes('INBOX')) return false;
  }

  const kind: MessageKind = outgoing ? 'OTHER' : classify(m, known);
  const subject = (m.headers['subject'] ?? '(no subject)').slice(0, 500);
  const clean = (s: string) => s.replace(/\u0000/g, '');

  await db.$transaction(async (tx) => {
    const t = await tx.thread.upsert({
      where: { studentId_gmailThreadId: { studentId, gmailThreadId: m.threadId } },
      create: { studentId, gmailThreadId: m.threadId, subject: clean(subject), lastMessageAt: m.date, emailId: email?.id ?? null },
      update: {},
    });
    await tx.message.create({
      data: {
        studentId,
        threadId: t.id,
        gmailMessageId: m.id,
        outgoing,
        kind,
        fromName: nameOf(m.headers['from']),
        fromEmail: from,
        toText: clean((m.headers['to'] ?? '').slice(0, 500)),
        subject: clean(subject),
        snippet: clean(m.snippet.slice(0, 300)),
        body: clean(m.body),
        messageIdHeader: ids(m.headers['message-id'])[0] ?? null,
        attachments: m.attachments as any,
        sentAt: m.date,
      },
    });
    const newest = m.date >= t.lastMessageAt;
    await tx.thread.update({
      where: { id: t.id },
      data: {
        ...(newest ? { lastMessageAt: m.date, snippet: clean(m.snippet.slice(0, 300)) } : {}),
        ...(email && !t.emailId ? { emailId: email.id } : {}),
        ...(outgoing
          ? {}
          : {
              hasIncoming: true,
              unread: true,
              ...(newest || !t.fromEmail ? { fromEmail: from, fromName: nameOf(m.headers['from']) } : {}),
              ...(STRENGTH.indexOf(kind) > STRENGTH.indexOf(t.kind) ? { kind } : {}),
            }),
      },
    });
    if (!email) return;
    if (outgoing) {
      // the student pressed Send in Gmail before our time came
      await tx.email.updateMany({ where: { id: email.id, status: { in: ['PENDING', 'GENERATING', 'GEN_FAILED', 'DRAFT', 'SCHEDULED', 'UNCERTAIN', 'CANCELLED'] }, gmailThreadId: m.threadId }, data: { status: 'SENT', sentAt: m.date, sentTo: addressOf(m.headers['to']), gmailMessageId: m.id, gmailDraftId: null, claimToken: null, error: null } });
    } else if (kind === 'PROFESSOR') {
      await tx.email.updateMany({ where: { id: email.id, repliedAt: null }, data: { repliedAt: m.date } });
    } else if (kind === 'BOUNCE' && !/delay|incomplete|warning|still being retried/i.test(subject)) {
      await tx.email.updateMany({ where: { id: email.id, status: 'SENT', repliedAt: null }, data: { status: 'BOUNCED', bouncedAt: m.date, error: clean(m.snippet.slice(0, 300)) } });
    }
  });
  if (email && kind === 'BOUNCE') await guardBounces(email.campaignId);
  return true;
}

/** Too many dead addresses hurt the student's Gmail: stop and let a person look. */
export async function guardBounces(campaignId: string) {
  const last = await db.email.findMany({ where: { campaignId, status: { in: ['SENT', 'BOUNCED'] } }, orderBy: { sentAt: 'desc' }, take: 30, select: { status: true } });
  const bad = last.filter((e) => e.status === 'BOUNCED').length;
  if (bad >= 4 && bad / last.length >= 0.15) {
    const stopped = await db.campaign.updateMany({ where: { id: campaignId, paused: false }, data: { paused: true, pauseReason: `Paused by the system: ${bad} of the last ${last.length} emails bounced. Check the addresses.` } });
    if (stopped.count) await audit('worker', 'campaign.auto_paused', 'Campaign', campaignId, { bad, of: last.length });
  }
}

/**
 * A draft deleted in Gmail means: do not send this one. The email is cancelled here too, and the
 * professor is free again. A draft that is gone because it was sent counts as sent.
 */
export async function noticeDeletedDrafts(studentId: string): Promise<number> {
  const mine = await db.email.findMany({
    where: { studentId, status: { in: ['SCHEDULED', 'DRAFT', 'PENDING', 'GEN_FAILED'] }, gmailDraftId: { not: null }, draftedAt: { lt: new Date(Date.now() - 60_000) }, OR: [{ claimToken: null }, { claimedAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
    select: { id: true, status: true, gmailDraftId: true, gmailThreadId: true },
  });
  if (!mine.length) return 0;
  const there = new Set(await mail().listDrafts(studentId));
  let n = 0;
  for (const e of mine) {
    if (there.has(e.gmailDraftId!)) continue;
    // ask for this very draft once more: a list can be a moment behind
    if ((await mail().draftRecipient(studentId, e.gmailDraftId!)) !== null) continue;
    const same = { id: e.id, status: e.status, gmailDraftId: e.gmailDraftId };
    const sent = e.gmailThreadId ? await mail().findSent(studentId, e.gmailThreadId) : null;
    if (sent) {
      await db.email.updateMany({ where: same, data: { status: 'SENT', sentAt: sent.sentAt ?? new Date(), gmailMessageId: sent.messageId, gmailDraftId: null, claimToken: null, error: null } });
      continue;
    }
    if (e.status !== 'SCHEDULED') {
      // staff are having it written again: only the old draft is forgotten, a new one is made later
      await db.email.updateMany({ where: same, data: { gmailDraftId: null, gmailThreadId: null, draftVersion: null, draftTo: null, draftedAt: null } });
      continue;
    }
    const done = await db.email.updateMany({ where: same, data: { status: 'CANCELLED', error: 'Its draft was deleted in Gmail.', gmailDraftId: null, gmailThreadId: null, draftVersion: null, draftTo: null, draftedAt: null, scheduledFor: null, sendNow: false, claimToken: null } });
    if (!done.count) continue;
    n++;
    await audit('worker', 'email.draft_deleted_in_gmail', 'Email', e.id);
  }
  return n;
}

export async function syncMailbox(studentId: string) {
  const mb = await db.mailbox.findUniqueOrThrow({ where: { studentId } });
  const next = (sec: number) => new Date(Date.now() + sec * 1000);
  try {
    if (!mb.historyId) {
      await db.mailbox.update({ where: { id: mb.id }, data: { historyId: await mail().currentHistory(studentId), lastSyncAt: new Date(), nextSyncAt: next(env().SYNC_SECONDS), syncClaimedAt: null } });
      return 0;
    }
    let found: { ids: string[]; historyId: string };
    try {
      found = await mail().changes(studentId, mb.historyId);
    } catch (e) {
      if (!(e instanceof MailError) || e.kind !== 'NOT_FOUND') throw e;
      // Gmail forgot that point (about a week): take the new point first, then read everything since
      const historyId = await mail().currentHistory(studentId);
      const since = new Date((mb.lastSyncAt ?? mb.connectedAt).getTime() - 24 * 3600_000);
      found = { historyId, ids: await mail().recentIds(studentId, since) };
    }
    const have = new Set((await db.message.findMany({ where: { studentId, gmailMessageId: { in: found.ids } }, select: { gmailMessageId: true } })).map((m) => m.gmailMessageId));
    let fresh = 0;
    await noticeDeletedDrafts(studentId);
    for (const id of found.ids) {
      if (have.has(id)) continue;
      const m = await mail().getMessage(studentId, id);
      if (m && (await ingest(studentId, mb.email, m))) fresh++;
    }
    // the point moves on only after every message above is stored
    await db.mailbox.update({ where: { id: mb.id }, data: { historyId: found.historyId, lastSyncAt: new Date(), nextSyncAt: next(env().SYNC_SECONDS), syncClaimedAt: null, lastError: null } });
    return fresh;
  } catch (e: any) {
    if (e instanceof MailError && e.kind === 'AUTH') await noteMailboxError(studentId, e);
    await db.mailbox.update({ where: { id: mb.id }, data: { syncClaimedAt: null, nextSyncAt: next(e instanceof MailError && e.kind === 'TRANSIENT' ? 60 : 300), lastError: String(e?.message ?? e).slice(0, 300) } });
    return 0;
  }
}

/** Reads the mailboxes whose turn it is. */
export async function syncDue(limit = 10): Promise<number> {
  const rows = await db.$queryRaw<{ studentId: string }[]>`
    UPDATE "Mailbox" SET "syncClaimedAt" = now()
    WHERE id IN (
      SELECT id FROM "Mailbox"
      WHERE status = 'CONNECTED' AND "nextSyncAt" <= now() AND ("syncClaimedAt" IS NULL OR "syncClaimedAt" < now() - interval '10 minutes')
      ORDER BY "nextSyncAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING "studentId"`;
  await Promise.all(rows.map((r) => syncMailbox(r.studentId)));
  return rows.length;
}

const LOOK = 'Gmail did not confirm this reply. Look in the student’s Sent and Drafts; if it is not there, reload the page and write it again.';

/** One row per reply. The same key again means the same reply: sent already, or a retry after a clear failure. */
async function claimReply(threadId: string, body: string, clientKey: string, staff: string) {
  try {
    return await db.staffReply.create({ data: { clientKey, threadId, staffEmail: staff, body } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
  const old = await db.staffReply.findUniqueOrThrow({ where: { clientKey } });
  if (old.threadId !== threadId) throw new UserError('Reload the page and try again.');
  if (old.status === 'SENT') return 'sent' as const;
  if (old.status === 'UNCERTAIN') throw new UserError(LOOK);
  const again = await db.staffReply.updateMany({ where: { clientKey, status: 'FAILED' }, data: { status: 'SENDING', error: null, body } });
  if (!again.count) throw new UserError('This reply is being sent.');
  return { ...old, body };
}

/** An answer goes to the real person when the campaign of the conversation is LIVE. */
export async function threadIsLive(t: { emailId: string | null; studentId: string }): Promise<boolean> {
  const email = t.emailId ? await db.email.findUnique({ where: { id: t.emailId }, select: { campaign: { select: { live: true } } } }) : null;
  return email ? email.campaign.live : (await db.campaign.count({ where: { studentId: t.studentId, live: true } })) > 0;
}

/** A reply written by staff, sent from the student's Gmail in the same conversation. */
export async function replyToThread(threadId: string, body: string, clientKey: string, staff: string) {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (!text) throw new UserError('Write something first.');
  if (sandboxMissing()) throw new UserError('Set the test inbox (EMAIL_SANDBOX_TO) first.');
  const t = await db.thread.findUniqueOrThrow({ where: { id: threadId }, include: { student: { include: { mailbox: true } }, messages: { orderBy: { sentAt: 'asc' } } } });
  if (t.student.mailbox?.status !== 'CONNECTED') throw new UserError('This student’s Gmail is not connected.');
  const last = [...t.messages].reverse().find((m) => !m.outgoing && m.kind !== 'BOUNCE');
  if (!last) throw new UserError('There is nobody to answer in this conversation.');
  const row = await claimReply(threadId, text, clientKey, staff);
  if (row === 'sent') return; // the same reply, submitted twice
  const fail = (status: string, error: string) => db.staffReply.update({ where: { id: row.id }, data: { status, error } });

  const live = await threadIsLive(t);
  const r = recipientFor(last.fromEmail, /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`, live);
  const refs = t.messages.map((m) => m.messageIdHeader).filter((x): x is string => !!x).slice(-10);
  let draftId: string;
  try {
    const msg = { live, fromName: t.student.fullName, to: r.to, subject: r.subject, body: text, threadId: t.gmailThreadId, inReplyTo: last.messageIdHeader ?? undefined, references: refs.join(' ') || undefined };
    // a second try uses the draft of the first one, so there is never a second copy
    const d = row.gmailDraftId ? await mail().updateDraft(t.studentId, row.gmailDraftId, msg) : await mail().createDraft(t.studentId, msg);
    draftId = d.draftId;
    await db.staffReply.update({ where: { id: row.id }, data: { gmailDraftId: draftId } });
  } catch (e: any) {
    if (e instanceof MailError) await noteMailboxError(t.studentId, e);
    const gone = e instanceof MailError && e.kind === 'NOT_FOUND' && !!row.gmailDraftId;
    await fail(gone ? 'UNCERTAIN' : 'FAILED', String(e?.message ?? e).slice(0, 300));
    throw new UserError(gone ? LOOK : 'Gmail did not take the reply. Nothing was sent.');
  }
  try {
    const sent = await mail().sendDraft(t.studentId, draftId);
    await db.staffReply.update({ where: { id: row.id }, data: { status: 'SENT' } });
    await audit(staff, 'inbox.replied', 'Thread', threadId, { to: r.to });
    const m = await mail().getMessage(t.studentId, sent.messageId).catch(() => null);
    if (m) await ingest(t.studentId, t.student.mailbox.email, m);
  } catch (e: any) {
    if (e instanceof MailError) await noteMailboxError(t.studentId, e);
    const done = await db.staffReply.findUnique({ where: { id: row.id } });
    if (done?.status === 'SENT') return; // sent; only showing it failed, the next sync brings it
    const known = e instanceof MailError && ['AUTH', 'RATE', 'REJECTED'].includes(e.kind);
    await fail(known ? 'FAILED' : 'UNCERTAIN', String(e?.message ?? e).slice(0, 300));
    throw new UserError(known ? 'Gmail refused the reply. It is in the student’s Drafts and was not sent.' : LOOK);
  }
}
