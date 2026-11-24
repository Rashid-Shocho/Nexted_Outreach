import { currentStaff } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentStaff())) return new Response('Sign in first', { status: 401 });
  const p = await db.studentProfile.findUnique({ where: { id: (await params).id }, select: { content: true } });
  if (!p) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(p.content), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="profile.pdf"', 'Cache-Control': 'private, no-store' },
  });
}
