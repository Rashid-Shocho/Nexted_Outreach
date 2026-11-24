import { currentStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { mail, MailError } from '@/lib/mail';

/** Attachments stay in Gmail and are always downloaded, never opened inside this site. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  if (!(await currentStaff())) return new Response('Sign in first', { status: 401 });
  const { id, n } = await params;
  const m = await db.message.findUnique({ where: { id } });
  const f = (m?.attachments as { name: string; attachmentId: string }[] | undefined)?.[Number(n)];
  if (!m || !f) return new Response('Not found', { status: 404 });
  try {
    const bytes = await mail().getAttachment(m.studentId, m.gmailMessageId, f.attachmentId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return new Response(e instanceof MailError ? 'Gmail could not give this file now.' : 'Error', { status: 502 });
  }
}
