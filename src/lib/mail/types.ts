export interface Attachment {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface OutMessage {
  fromName?: string;
  to: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  /** The body uses **bold**, *italic* and "- " lists: send it as HTML with a plain copy */
  markup?: boolean;
  /** From a campaign marked LIVE (or an answer in one): may go to the real address */
  live?: boolean;
  /** Replies only */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export interface DraftRef {
  draftId: string;
  threadId: string;
}

export interface SentRef {
  messageId: string;
  threadId: string;
  sentAt?: Date;
}

export interface InMessage {
  id: string;
  threadId: string;
  labels: string[];
  headers: Record<string, string>; // names in lower case
  snippet: string;
  body: string;
  attachments: { name: string; mimeType: string; size: number; attachmentId: string }[];
  date: Date;
}

/**
 * AUTH      the Gmail connection is gone: reconnect
 * NOT_FOUND the draft / message / history no longer exists
 * RATE      Gmail asked us to slow down
 * REJECTED  Gmail refused this message (bad address...): do not retry
 * TRANSIENT network or server trouble: the outcome may be unknown
 */
export type MailErrorKind = 'AUTH' | 'NOT_FOUND' | 'RATE' | 'REJECTED' | 'TRANSIENT';

export class MailError extends Error {
  constructor(
    public readonly kind: MailErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** One student's mailbox. `studentId` picks the mailbox in every call. */
export interface MailProvider {
  createDraft(studentId: string, msg: OutMessage): Promise<DraftRef>;
  updateDraft(studentId: string, draftId: string, msg: OutMessage): Promise<DraftRef>;
  /** The draft's current recipient, or null when the draft is gone. One in Trash counts as gone: Gmail keeps it, and would even send it */
  draftRecipient(studentId: string, draftId: string): Promise<string | null>;
  sendDraft(studentId: string, draftId: string): Promise<SentRef>;
  deleteDraft(studentId: string, draftId: string): Promise<void>;
  /** How many messages older than 30 days the account has, counted up to `limit` */
  oldMessages(studentId: string, limit: number): Promise<number>;
  /** Ids of every draft in the mailbox, without those in Trash */
  listDrafts(studentId: string): Promise<string[]>;
  /** The message we sent in a thread, if Gmail has one */
  findSent(studentId: string, threadId: string): Promise<SentRef | null>;
  currentHistory(studentId: string): Promise<string>;
  /** Ids of messages added since `historyId`; throws NOT_FOUND when Gmail has forgotten that point */
  changes(studentId: string, historyId: string): Promise<{ ids: string[]; historyId: string }>;
  recentIds(studentId: string, since: Date): Promise<string[]>;
  getMessage(studentId: string, id: string): Promise<InMessage | null>;
  getAttachment(studentId: string, messageId: string, attachmentId: string): Promise<Buffer>;
}
