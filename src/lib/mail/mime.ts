import crypto from 'node:crypto';
import type { InMessage, OutMessage } from './types';

/** Building and reading email messages. Pure. */

const oneLine = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ').trim();

/** RFC 2047, in pieces of at most 75 characters that never cut a UTF-8 character. */
export function encodeHeader(raw: string): string {
  const s = oneLine(raw);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

const b64lines = (b: Buffer) => b.toString('base64').replace(/(.{76})/g, '$1\r\n');

export function assertAddress(to: string): string {
  const t = to.trim();
  if (!/^[^\s@<>,;:"()]+@[^\s@<>,;:"()]+\.[^\s@<>,;:"()]+$/.test(t)) throw new Error(`Not a single email address: ${oneLine(to).slice(0, 80)}`);
  return t;
}

const quoteName = (n: string) => (/^[\x20-\x7e]*$/.test(n) ? `"${oneLine(n).replace(/["\\]/g, '')}"` : encodeHeader(n));

export const toPlain = (s: string) => s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s.,;:!?)])/g, '$1$2');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s: string) => escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');

/** Only bold, italic, lists and paragraphs; everything else is shown as written. */
export function toHtml(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => {
      const lines = p.split('\n');
      if (lines.every((l) => /^\s*- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*- /, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('\n');
}

/** RFC 2045 quoted-printable, the form mail programs use for ordinary text. */
export function quotedPrintable(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8');
      let out = '';
      let col = 0;
      bytes.forEach((b, i) => {
        const last = i === bytes.length - 1;
        const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
        const t = plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
        if (col + t.length > 75) {
          out += '=\r\n';
          col = 0;
        }
        out += t;
        col += t.length;
      });
      return out;
    })
    .join('\r\n');
}

export function buildMime(from: string, m: OutMessage): string {
  const headers = [
    `From: ${m.fromName ? `${quoteName(m.fromName)} <${from}>` : from}`,
    `To: ${assertAddress(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${oneLine(m.references)}`] : []),
    'MIME-Version: 1.0',
  ];
  const part = (type: string, s: string) => [`Content-Type: ${type}; charset="UTF-8"`, 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(s)].join('\r\n');
  let text = part('text/plain', m.markup ? toPlain(m.body) : m.body);
  if (m.markup) {
    const alt = `alt_${crypto.randomBytes(12).toString('hex')}`;
    text = [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, text, `--${alt}`, part('text/html', toHtml(m.body)), `--${alt}--`, ''].join('\r\n');
  }
  if (!m.attachments?.length) return [...headers, text].join('\r\n');

  const boundary = `nx_${crypto.randomBytes(12).toString('hex')}`;
  const parts = [
    text,
    ...m.attachments.map((a) => {
      const ascii = a.fileName.replace(/[^\w.\- ]/g, '_');
      const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : 'application/octet-stream';
      return [
        `Content-Type: ${type}; name="${ascii}"`,
        `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(oneLine(a.fileName)).replace(/['()*]/g, '_')}`,
        'Content-Transfer-Encoding: base64',
        '',
        b64lines(a.bytes),
      ].join('\r\n');
    }),
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ''].join('\r\n');
}

export const b64url = (b: Buffer) => b.toString('base64url');

export function addressOf(header: string | undefined): string {
  const h = header ?? '';
  return (h.match(/<([^<>]+)>\s*$/)?.[1] ?? h.match(/<([^<>]+)>/)?.[1] ?? h).trim().toLowerCase();
}

export function nameOf(header: string | undefined): string | null {
  const n = (header ?? '').replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return n && !n.includes('@') ? n.slice(0, 200) : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026' };
const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

export const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => codePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

/** The inbox shows plain text only: no remote images, scripts or styles ever run. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

/** A Gmail API message (format=full) as plain text plus a list of attachments. */
export function parseGmailMessage(m: any): InMessage {
  const headers: Record<string, string> = {};
  for (const h of (m.payload?.headers ?? []) as { name: string; value: string }[]) headers[h.name.toLowerCase()] ??= h.value;
  let plain = '';
  let html = '';
  const attachments: InMessage['attachments'] = [];
  const walk = (p: GmailPart | undefined, depth = 0) => {
    if (!p || depth > 20) return;
    const data = p.body?.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ name: p.filename.slice(0, 200), mimeType: p.mimeType ?? 'application/octet-stream', size: p.body.size ?? 0, attachmentId: p.body.attachmentId });
    } else if (p.mimeType === 'text/plain') plain += (plain ? '\n' : '') + data;
    else if (p.mimeType === 'text/html') html += data;
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(m.payload);
  return {
    id: m.id,
    threadId: m.threadId,
    labels: m.labelIds ?? [],
    headers,
    snippet: decodeEntities(m.snippet ?? ''),
    body: (plain.trim() || htmlToText(html)).slice(0, 100_000),
    attachments,
    date: new Date(Number(m.internalDate ?? Date.now())),
  };
}

export type Kind = 'PROFESSOR' | 'AUTO_REPLY' | 'BOUNCE' | 'OTHER';

/** What an incoming message is. `known` = it belongs to a conversation with one of our professors. */
export function classify(m: Pick<InMessage, 'headers' | 'snippet' | 'body'>, known: boolean): Kind {
  const from = m.headers['from'] ?? '';
  const subject = m.headers['subject'] ?? '';
  if (/mailer-daemon@|postmaster@|mail delivery (subsystem|system)/i.test(from)) return 'BOUNCE';
  if (!known) return 'OTHER';
  const auto = m.headers['auto-submitted'];
  if ((auto && !/^no\b/i.test(auto)) || m.headers['x-autoreply'] || m.headers['x-autorespond'] || /^(auto(matic)?[- ]?(reply|response)|out of (the )?office|abwesenheit|r[ée]ponse automatique)/i.test(subject.trim())) {
    return 'AUTO_REPLY';
  }
  return 'PROFESSOR';
}

/** Where every outgoing email really goes while the sandbox is on. */
export function resolveRecipient(to: string, subject: string, cfg: { sandbox: boolean; sandboxTo?: string; allow?: string[] }) {
  if (!cfg.sandbox) return { to: to.trim(), subject, sandboxed: false };
  if (!cfg.sandboxTo) throw new Error('The sandbox is on but EMAIL_SANDBOX_TO is empty: refusing to send.');
  if (cfg.allow?.includes(to.trim().toLowerCase())) return { to: to.trim(), subject: `[TEST] ${subject}`, sandboxed: true };
  return { to: cfg.sandboxTo.trim(), subject: `[SANDBOX to ${to.trim()}] ${subject}`, sandboxed: true };
}
