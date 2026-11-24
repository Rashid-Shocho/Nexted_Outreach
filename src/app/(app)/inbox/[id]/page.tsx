import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { env, ownTestAddress, testMode } from '@/lib/env';
import { threadIsLive } from '@/lib/pipeline/inbox';
import * as A from '../../../actions';
import { ActionButton, MarkRead, ReplyBox } from '@/components/client';
import { Chip, Head, when } from '@/components/ui';

export const metadata = { title: 'Conversation' };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  const t = await db.thread.findUnique({ where: { id }, include: { student: { include: { mailbox: { select: { status: true } } } }, messages: { orderBy: { sentAt: 'asc' } } } });
  if (!t) notFound();
  const [email, failed] = await Promise.all([
    t.emailId ? db.email.findUnique({ where: { id: t.emailId }, include: { professor: true } }) : null,
    db.staffReply.findMany({ where: { threadId: id, status: { in: ['FAILED', 'UNCERTAIN'] } }, orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);
  const test = testMode(await threadIsLive(t));
  const last = [...t.messages].reverse().find((m) => !m.outgoing && m.kind !== 'BOUNCE');
  return (
    <>
      <MarkRead key={t.lastMessageAt.toISOString()} action={A.setUnread.bind(null, id, false)} />
      <Head
        title={t.subject}
        sub={<><Link href="/inbox">Inbox</Link> · <Link href={`/students/${t.studentId}`}>{t.student.fullName}</Link>{email ? <> · <Link href={`/emails/${email.id}`}>{email.professor.name}{email.professor.university ? `, ${email.professor.university}` : ''}</Link></> : null}</>}
      >
        <Chip s={t.kind} />
        <ActionButton action={A.setUnread.bind(null, id, true)} label="Mark unread" />
      </Head>
      <section className="card">
        {t.messages.map((m) => {
          const files = m.attachments as { name: string; size: number }[];
          return (
            <article key={m.id} className={`msg ${m.outgoing ? 'out' : 'in'}`}>
              <div className="between"><b>{m.outgoing ? t.student.fullName : (m.fromName ?? m.fromEmail)}</b><span className="muted small">{when(m.sentAt)}</span></div>
              <p className="muted small">{m.fromEmail} to {m.toText}</p>
              <div className="mailtext">{m.body}</div>
              {files.length ? (
                <p className="small" style={{ marginTop: 8 }}>
                  {files.map((f, i) => <a key={i} href={`/api/attachments/${m.id}/${i}`} style={{ marginRight: 12 }}>{f.name} ({Math.max(1, Math.round(f.size / 1024))} KB)</a>)}
                </p>
              ) : null}
            </article>
          );
        })}
        {failed.map((r) => (
          <p key={r.id} className="note bad">A reply by {r.staffEmail} ({when(r.createdAt)}) {r.status === 'FAILED' ? 'was not sent' : 'may or may not have been sent'}: {r.error}</p>
        ))}
        {last && t.student.mailbox?.status === 'CONNECTED' ? (
          <ReplyBox action={A.sendReply.bind(null, id)} to={`${test && !ownTestAddress(last.fromEmail) ? `${env().EMAIL_SANDBOX_TO} (test mode)` : last.fromEmail} as ${t.student.fullName}`} />
        ) : last ? <p className="note bad">Connect this student’s Gmail to reply.</p> : null}
      </section>
    </>
  );
}
