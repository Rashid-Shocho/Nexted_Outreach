import { sha256 } from '@/lib/crypto';
import { db } from '@/lib/db';
import { startConnect } from '../../actions';

export const metadata = { title: 'Connect Gmail' };
export const dynamic = 'force-dynamic';

export default async function Connect({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await db.connectLink.findUnique({ where: { tokenHash: sha256(token) } });
  const st = link && !link.usedAt && link.expiresAt > new Date() ? await db.student.findUnique({ where: { id: link.studentId }, select: { email: true } }) : null;
  return (
    <main className="login">
      <div className="card">
        <h1 style={{ marginBottom: 14 }}>Connect your Gmail</h1>
        {st ? (
          <>
            <p>nextED will prepare and send emails to professors from <b>{st.email}</b>, and read that mailbox to show the answers.</p>
            <p className="muted small">You sign in on Google’s own page. We never see your password, and you can end the access at any time in your Google account.</p>
            <form action={startConnect.bind(null, token)}><button className="btn">Continue to Google</button></form>
          </>
        ) : <p>This link was used already or is too old. Please ask for a new one.</p>}
      </div>
    </main>
  );
}
