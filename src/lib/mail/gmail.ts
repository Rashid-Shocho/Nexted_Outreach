import { db } from '../db';
import { decrypt, encrypt } from '../crypto';
import { env, gmailRedirectUri } from '../env';
import { googleFetch } from '../googleFetch';
import { netReason, reach } from '../reach';
import { addressOf, b64url, buildMime, parseGmailMessage } from './mime';
import { MailError, type DraftRef, type InMessage, type MailProvider, type OutMessage, type SentRef } from './types';

/** gmail.modify covers drafts, sending and reading. It cannot delete mail for good. */
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function authUrl(state: string, loginHint: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: env().GMAIL_OAUTH_CLIENT_ID!,
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    login_hint: loginHint,
  }).toString();
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  let res: Response;
  try {
    res = await reach('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env().GMAIL_OAUTH_CLIENT_ID!, client_secret: env().GMAIL_OAUTH_CLIENT_SECRET!, ...params }),
    }, { via: googleFetch });
  } catch (e: any) {
    throw new MailError('TRANSIENT', `Google’s login server could not be reached (${netReason(e)}).`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.error === 'invalid_grant') throw new MailError('AUTH', 'Google ended this connection. Connect Gmail again.');
    throw new MailError(res.status >= 500 || res.status === 429 ? 'TRANSIENT' : 'AUTH', `Google login error: ${data?.error ?? res.status}`);
  }
  return data as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
}

const expiry = (sec: number) => new Date(Date.now() + (sec - 120) * 1000);

/** Finishes "Connect Gmail". Refuses any account other than the student's own. */
export async function finishConnect(code: string, studentId: string): Promise<string> {
  const student = await db.student.findUniqueOrThrow({ where: { id: studentId } });
  const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: gmailRedirectUri() });
  if (!tok.refresh_token) throw new Error('Google did not return a lasting connection. Remove the app in the Google account and try again.');
  if (!tok.scope.split(' ').includes(SCOPE)) throw new Error('The Gmail permission was not ticked. Connect again and allow it.');
  let res: Response;
  try {
    // Google's code works once, so this is tried for longer than usual
    res = await reach(`${API}/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` } }, { waits: [1000, 2000, 4000, 8000, 10_000], via: googleFetch });
  } catch (e) {
    throw new Error(`Gmail’s server could not be reached from this computer (${netReason(e)}). Check the internet connection and press Connect Gmail again.`);
  }
  const profile: any = await res.json();
  if (!res.ok) throw new Error(`Gmail did not answer (${res.status}). Is the Gmail API turned on in Google Cloud?`);
  const email = String(profile.emailAddress).toLowerCase();
  if (email !== student.email) throw new Error(`You signed in as ${email}, but this student is ${student.email}. Nothing was connected.`);
  const data = {
    email,
    encryptedRefreshToken: encrypt(tok.refresh_token),
    encryptedAccessToken: encrypt(tok.access_token),
    accessTokenExpiresAt: expiry(tok.expires_in),
    status: 'CONNECTED' as const,
    lastError: null,
    connectedAt: new Date(),
    nextSyncAt: new Date(),
  };
  // historyId is kept on a reconnect, so mail that arrived meanwhile is still found
  await db.mailbox.upsert({ where: { studentId }, create: { studentId, ...data, historyId: String(profile.historyId) }, update: data });
  return email;
}

async function token(studentId: string, force = false): Promise<{ email: string; accessToken: string }> {
  const mb = await db.mailbox.findUnique({ where: { studentId } });
  if (!mb) throw new MailError('AUTH', 'Gmail is not connected for this student.');
  if (!force && mb.encryptedAccessToken && mb.accessTokenExpiresAt && mb.accessTokenExpiresAt > new Date()) {
    return { email: mb.email, accessToken: decrypt(mb.encryptedAccessToken) };
  }
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(mb.encryptedRefreshToken) });
  await db.mailbox.update({
    where: { id: mb.id },
    data: {
      encryptedAccessToken: encrypt(tok.access_token),
      accessTokenExpiresAt: expiry(tok.expires_in),
      ...(tok.refresh_token ? { encryptedRefreshToken: encrypt(tok.refresh_token) } : {}),
    },
  });
  return { email: mb.email, accessToken: tok.access_token };
}

async function call(studentId: string, path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const { accessToken } = await token(studentId, retried);
  let res: Response;
  let data: any;
  try {
    res = await reach(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }, { via: googleFetch });
    data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  } catch (e: any) {
    throw new MailError('TRANSIENT', `Gmail could not be reached (${netReason(e)}).`);
  }
  if (res.ok) return data;
  if (res.status === 401 && !retried) return call(studentId, path, init, true);
  const reason = String(data?.error?.errors?.[0]?.reason ?? '');
  const msg = `Gmail ${res.status} ${reason}: ${String(data?.error?.message ?? '').slice(0, 200)}`;
  if (res.status === 401) throw new MailError('AUTH', msg);
  if (res.status === 404) throw new MailError('NOT_FOUND', msg);
  if (res.status === 429 || /rateLimit|dailyLimit|quota/i.test(reason)) throw new MailError('RATE', msg);
  if (res.status === 403) throw new MailError('AUTH', msg);
  if (res.status >= 500 || res.status === 408) throw new MailError('TRANSIENT', msg);
  throw new MailError('REJECTED', msg);
}

async function rawOf(studentId: string, m: OutMessage) {
  const { email } = await token(studentId);
  return b64url(Buffer.from(buildMime(email, m), 'utf8'));
}

const asDraft = (d: any): DraftRef => ({ draftId: d.id, threadId: d.message.threadId });
const enc = encodeURIComponent;

export const gmailProvider: MailProvider = {
  async createDraft(studentId, msg) {
    const raw = await rawOf(studentId, msg);
    return asDraft(await call(studentId, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) } }) }));
  },
  async updateDraft(studentId, draftId, msg) {
    const raw = await rawOf(studentId, msg);
    return asDraft(await call(studentId, `/drafts/${enc(draftId)}`, { method: 'PUT', body: JSON.stringify({ message: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) } }) }));
  },
  async draftRecipient(studentId, draftId) {
    try {
      const d = await call(studentId, `/drafts/${enc(draftId)}?format=metadata`);
      if (d.message?.labelIds?.includes('TRASH')) return null;
      const heads = (d.message?.payload?.headers ?? []) as { name: string; value: string }[];
      const list = heads.filter((h) => /^(to|cc|bcc)$/i.test(h.name)).map((h) => h.value);
      return list.length === 1 && !list[0].includes(',') ? addressOf(list[0]) : list.join(', ');
    } catch (e) {
      if (e instanceof MailError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  },
  async sendDraft(studentId, draftId): Promise<SentRef> {
    const d = await call(studentId, '/drafts/send', { method: 'POST', body: JSON.stringify({ id: draftId }) });
    return { messageId: d.id, threadId: d.threadId };
  },
  async deleteDraft(studentId, draftId) {
    await call(studentId, `/drafts/${enc(draftId)}`, { method: 'DELETE' });
  },
  async listDrafts(studentId) {
    const ids: string[] = [];
    let page = '';
    do {
      const d: any = await call(studentId, `/drafts?maxResults=500${page ? `&pageToken=${enc(page)}` : ''}`);
      for (const x of d.drafts ?? []) ids.push(x.id);
      page = d.nextPageToken ?? '';
    } while (page && ids.length < 10_000);
    return ids;
  },
  async findSent(studentId, threadId): Promise<SentRef | null> {
    try {
      const t = await call(studentId, `/threads/${enc(threadId)}?format=minimal`);
      const m = ((t.messages ?? []) as any[]).find((x) => x.labelIds?.includes('SENT') && !x.labelIds.includes('DRAFT'));
      return m ? { messageId: m.id, threadId, sentAt: new Date(Number(m.internalDate)) } : null;
    } catch (e) {
      if (e instanceof MailError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  },
  async currentHistory(studentId) {
    return String((await call(studentId, '/profile')).historyId);
  },
  async changes(studentId, historyId) {
    const ids = new Set<string>();
    let latest = historyId;
    let page = '';
    do {
      const d: any = await call(studentId, `/history?historyTypes=messageAdded&maxResults=500&startHistoryId=${enc(historyId)}${page ? `&pageToken=${enc(page)}` : ''}`);
      for (const h of d.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
      latest = String(d.historyId ?? latest);
      page = d.nextPageToken ?? '';
    } while (page);
    return { ids: [...ids], historyId: latest };
  },
  async oldMessages(studentId, limit) {
    const d: any = await call(studentId, `/messages?maxResults=${limit}&q=${enc('older_than:30d')}`);
    return (d.messages ?? []).length;
  },
  async recentIds(studentId, since) {
    const ids: string[] = [];
    let page = '';
    do {
      const q = enc(`after:${Math.floor(since.getTime() / 1000)} -in:drafts -in:chats`);
      const d: any = await call(studentId, `/messages?includeSpamTrash=true&maxResults=500&q=${q}${page ? `&pageToken=${enc(page)}` : ''}`);
      for (const m of d.messages ?? []) ids.push(m.id);
      page = d.nextPageToken ?? '';
    } while (page && ids.length < 5000);
    return ids;
  },
  async getMessage(studentId, id): Promise<InMessage | null> {
    try {
      return parseGmailMessage(await call(studentId, `/messages/${enc(id)}?format=full`));
    } catch (e) {
      if (e instanceof MailError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  },
  async getAttachment(studentId, messageId, attachmentId) {
    const d = await call(studentId, `/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`);
    return Buffer.from(d.data, 'base64url');
  },
};
