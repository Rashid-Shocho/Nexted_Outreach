import { NextResponse, type NextRequest } from 'next/server';
import { currentStaff } from '@/lib/auth';
import { audit, db } from '@/lib/db';
import { sha256 } from '@/lib/crypto';
import { env } from '@/lib/env';
import { finishConnect } from '@/lib/mail/gmail';
import { oldMessages } from '@/lib/pipeline/account';

/** Google comes back here, for staff or for a student who opened a connection link. */
export async function GET(req: NextRequest) {
  const base = env().APP_URL;
  const go = (p: string) => NextResponse.redirect(new URL(p, base));
  const q = req.nextUrl.searchParams;
  const st = await db.oAuthState.findUnique({ where: { stateHash: sha256(q.get('state') ?? '') } });
  const staff = await currentStaff();
  if (!st) return go(staff ? '/students' : '/login');

  // only for the one who started it: that staff member, or that very browser
  const nonce = req.cookies.get('connect')?.value;
  const mine = st.staffId ? staff?.id === st.staffId : !!nonce && !!st.nonceHash && sha256(nonce) === st.nonceHash;
  if (!mine) return go(staff ? '/students' : st.staffId ? '/login' : '/connect/done?r=expired');
  const used = await db.oAuthState.deleteMany({ where: { stateHash: st.stateHash } }); // one use only
  const back = (msg: string) => go(st.staffId ? `/students/${st.studentId}?gmail=${encodeURIComponent(msg)}` : `/connect/done?r=${msg === 'connected' ? 'ok' : encodeURIComponent(msg)}`);
  if (!used.count || st.expiresAt < new Date()) return back('This took too long. Please start again.');
  const code = q.get('code');
  if (!code) return back('Google did not allow the connection.');
  try {
    const email = await finishConnect(code, st.studentId);
    if (st.linkId) await db.connectLink.updateMany({ where: { id: st.linkId }, data: { usedAt: new Date() } });
    await audit(staff?.email ?? 'student link', 'gmail.connected', 'Student', st.studentId, { email });
    await oldMessages(st.studentId, true).catch(() => undefined); // shown on the student page; asked again before real sending
    return back('connected');
  } catch (e: any) {
    console.error('[gmail connect]', e?.message ?? e);
    return back(String(e?.message ?? 'Connection failed.').slice(0, 200));
  }
}
