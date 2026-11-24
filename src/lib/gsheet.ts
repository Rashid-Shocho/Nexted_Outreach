/**
 * Reading one tab of a Google Sheet that is shared as "Anyone with the link: Viewer".
 * Only Google's own address is ever called, whatever was pasted.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export function sheetRef(link: string): { id: string; gid: string } | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const id = u.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,80})(?:\/|$)/)?.[1];
  if (!id) return null;
  const gid = u.hash.match(/gid=(\d{1,12})/)?.[1] ?? u.searchParams.get('gid') ?? '0';
  return /^\d{1,12}$/.test(gid) ? { id, gid } : { id, gid: '0' };
}

export class SheetError extends Error {}

const PRIVATE = 'This Google Sheet is not shared. In Google Sheets: Share, General access, “Anyone with the link”, Viewer. Then paste the link again.';

/** The tab as CSV text. Throws SheetError with a text for staff. */
export async function readGoogleSheet(link: string): Promise<{ name: string; csv: Buffer }> {
  const ref = sheetRef(link);
  if (!ref) throw new SheetError('This is not a Google Sheets link. It looks like https://docs.google.com/spreadsheets/d/…');
  let res: Response;
  try {
    res = await fetch(`https://docs.google.com/spreadsheets/d/${ref.id}/export?format=csv&gid=${ref.gid}`, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SheetError('Google Sheets could not be reached. Try again.');
  }
  const host = new URL(res.url || 'https://docs.google.com').hostname;
  if (res.status === 404 || res.status === 400) throw new SheetError('This Google Sheet or tab was not found. Check the link.');
  if (res.status === 401 || res.status === 403 || host === 'accounts.google.com' || !/text\/csv/i.test(res.headers.get('content-type') ?? '')) throw new SheetError(PRIVATE);
  if (!res.ok) throw new SheetError(`Google Sheets answered ${res.status}. Try again.`);

  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new SheetError('This sheet is too large (more than 5 MB).');
    parts.push(Buffer.from(chunk));
  }
  // Google names the download "Spreadsheet name - Tab name.csv"
  const cd = res.headers.get('content-disposition') ?? '';
  let name = 'Google Sheet';
  try {
    name = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? '') || cd.match(/filename="([^"]+)"/)?.[1] || name;
  } catch {
    /* keep the plain name */
  }
  return { name: name.replace(/\.csv$/i, '').slice(0, 150), csv: Buffer.concat(parts) };
}
