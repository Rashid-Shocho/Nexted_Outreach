import { currentStaff } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentStaff())) return new Response('Sign in first', { status: 401 });
  const cv = await db.cv.findUnique({ where: { id: (await params).id }, select: { content: true } });
  if (!cv) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(cv.content), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cv.pdf"', 'Cache-Control': 'private, no-store' },
  });
}
