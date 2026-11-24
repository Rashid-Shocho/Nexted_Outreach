import crypto from 'node:crypto';
import { db } from '../db';
import { addressOf, assertAddress, toPlain } from './mime';
import { MailError, type InMessage, type MailProvider, type OutMessage } from './types';

/**
 * A pretend Gmail kept in the database, for development and tests. It copies the behaviour that
 * matters: a sent draft disappears, the sent message gets a new id in the same thread.
 */

const id = () => crypto.randomBytes(8).toString('hex');

/** Tests make calls fail here. */
export const fakeHooks: { before?: (op: string, studentId: string) => void | Promise<void>; after?: (op: string, studentId: string) => void | Promise<void>; /** Age of the pretend account */ oldMessages?: number } = {};

async function box(studentId: string, op: string) {
  await fakeHooks.before?.(op, studentId);
  const mb = await db.mailbox.findUnique({ where: { studentId } });
  if (!mb) throw new MailError('AUTH', 'Gmail is not connected for this student.');
  return mb.email;
}

const draftRow = async (mailbox: string, draftId: string) => {
  const d = await db.fakeMail.findFirst({ where: { mailbox, draftId } });
  if (!d) throw new MailError('NOT_FOUND', 'Fake Gmail: no such draft');
  return d;
};

const headersOf = (mailbox: string, m: OutMessage) => ({
  from: m.fromName ? `${m.fromName} <${mailbox}>` : mailbox,
  to: assertAddress(m.to),
  subject: m.subject,
  ...(m.inReplyTo ? { 'in-reply-to': m.inReplyTo } : {}),
  ...(m.references ? { references: m.references } : {}),
});

const filesOf = (m: OutMessage) => (m.attachments ?? []).map((a) => ({ name: a.fileName, mimeType: a.mimeType, size: a.bytes.length, data: a.bytes.toString('base64') }));

/** Puts a message into a student's pretend Inbox. */
export async function fakeIncoming(opts: { mailbox: string; from: string; subject: string; body: string; threadId?: string; headers?: Record<string, string> }) {
  return db.fakeMail.create({
    data: {
      mailbox: opts.mailbox,
      threadId: opts.threadId ?? id(),
      labels: ['INBOX', 'UNREAD'],
      headers: { from: opts.from, to: opts.mailbox, subject: opts.subject, 'message-id': `<${id()}@fake>`, ...(opts.headers ?? {}) },
      body: opts.body,
    },
  });
}

export const fakeProvider: MailProvider = {
  async createDraft(studentId, m) {
    const mailbox = await box(studentId, 'createDraft');
    const d = await db.fakeMail.create({ data: { mailbox, threadId: m.threadId ?? id(), draftId: `r${id()}`, labels: ['DRAFT'], headers: headersOf(mailbox, m), body: m.markup ? toPlain(m.body) : m.body, files: filesOf(m) } });
    await fakeHooks.after?.('createDraft', studentId);
    return { draftId: d.draftId!, threadId: d.threadId };
  },
  async updateDraft(studentId, draftId, m) {
    const mailbox = await box(studentId, 'updateDraft');
    const d = await draftRow(mailbox, draftId);
    await db.fakeMail.update({ where: { id: d.id }, data: { headers: headersOf(mailbox, m), body: m.markup ? toPlain(m.body) : m.body, files: filesOf(m) } });
    return { draftId, threadId: d.threadId };
  },
  async draftRecipient(studentId, draftId) {
    const mailbox = await box(studentId, 'draftRecipient');
    const d = await db.fakeMail.findFirst({ where: { mailbox, draftId } });
    return d && !d.labels.includes('TRASH') ? addressOf((d.headers as any).to) : null;
  },
  async sendDraft(studentId, draftId) {
    const mailbox = await box(studentId, 'sendDraft');
    const d = await draftRow(mailbox, draftId);
    const [, sent] = await db.$transaction([
      db.fakeMail.delete({ where: { id: d.id } }),
      db.fakeMail.create({ data: { mailbox, threadId: d.threadId, labels: ['SENT'], headers: { ...(d.headers as object), 'message-id': `<${id()}@fake>` }, body: d.body, files: d.files as any } }),
    ]);
    await fakeHooks.after?.('sendDraft', studentId);
    return { messageId: sent.id, threadId: sent.threadId };
  },
  async deleteDraft(studentId, draftId) {
    const mailbox = await box(studentId, 'deleteDraft');
    const d = await draftRow(mailbox, draftId);
    await db.fakeMail.delete({ where: { id: d.id } });
  },
  async listDrafts(studentId) {
    const mailbox = await box(studentId, 'listDrafts');
    return (await db.fakeMail.findMany({ where: { mailbox, draftId: { not: null }, NOT: { labels: { has: 'TRASH' } } }, select: { draftId: true } })).map((r) => r.draftId!);
  },
  async findSent(studentId, threadId) {
    const mailbox = await box(studentId, 'findSent');
    const m = await db.fakeMail.findFirst({ where: { mailbox, threadId, labels: { has: 'SENT' } }, orderBy: { seq: 'asc' } });
    return m ? { messageId: m.id, threadId, sentAt: m.createdAt } : null;
  },
  async currentHistory(studentId) {
    const mailbox = await box(studentId, 'currentHistory');
    const m = await db.fakeMail.aggregate({ where: { mailbox }, _max: { seq: true } });
    return String(m._max.seq ?? 0);
  },
  async changes(studentId, historyId) {
    const mailbox = await box(studentId, 'changes');
    const rows = await db.fakeMail.findMany({ where: { mailbox, seq: { gt: Number(historyId) } }, orderBy: { seq: 'asc' }, select: { id: true, seq: true } });
    return { ids: rows.map((r) => r.id), historyId: String(rows.at(-1)?.seq ?? historyId) };
  },
  async oldMessages(studentId, limit) {
    await box(studentId, 'oldMessages');
    return Math.min(limit, fakeHooks.oldMessages ?? limit);
  },
  async recentIds(studentId, since) {
    const mailbox = await box(studentId, 'recentIds');
    return (await db.fakeMail.findMany({ where: { mailbox, createdAt: { gte: since } }, select: { id: true } })).map((r) => r.id);
  },
  async getMessage(studentId, mid): Promise<InMessage | null> {
    const mailbox = await box(studentId, 'getMessage');
    const m = await db.fakeMail.findFirst({ where: { id: mid, mailbox } });
    if (!m) return null;
    const files = m.files as any[];
    return {
      id: m.id,
      threadId: m.threadId,
      labels: m.labels,
      headers: m.headers as Record<string, string>,
      snippet: m.body.replace(/\s+/g, ' ').slice(0, 160),
      body: m.body,
      attachments: files.map((f, i) => ({ name: f.name, mimeType: f.mimeType, size: f.size, attachmentId: String(i) })),
      date: m.createdAt,
    };
  },
  async getAttachment(studentId, messageId, attachmentId) {
    const mailbox = await box(studentId, 'getAttachment');
    const m = await db.fakeMail.findFirst({ where: { id: messageId, mailbox } });
    const f = (m?.files as any[] | undefined)?.[Number(attachmentId)];
    if (!f) throw new MailError('NOT_FOUND', 'Fake Gmail: no such attachment');
    return Buffer.from(f.data, 'base64');
  },
};
