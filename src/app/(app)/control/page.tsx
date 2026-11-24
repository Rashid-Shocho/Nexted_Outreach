import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { db, stops } from '@/lib/db';
import { campaignCounts, workerState } from '@/lib/queries';
import * as A from '../../actions';
import { ActionButton, AutoRefresh } from '@/components/client';
import { Chip, Head, inTime, when } from '@/components/ui';

export const metadata = { title: 'Control' };

const JOBS = [
  ['writing', 'Writing', 'Reading profiles and writing emails with the AI'],
  ['sending', 'Scheduling and sending', 'Putting drafts into Gmail and sending them at their time'],
  ['inbox', 'Reading mail', 'Fetching new mail into the inbox'],
] as const;

export default async function Control() {
  await requireStaff();
  const [st, worker, now, next, campaigns, leftover] = await Promise.all([
    stops(),
    workerState(),
    db.email.findMany({ where: { OR: [{ step: { not: null } }, { status: { in: ['GENERATING', 'SENDING'] } }] }, take: 10, include: { professor: { select: { name: true, rowNumber: true } }, student: { select: { fullName: true } } } }),
    db.email.findFirst({ where: { status: 'SCHEDULED', campaign: { status: 'ACTIVE', paused: false } }, orderBy: { scheduledFor: 'asc' }, include: { professor: { select: { name: true } } } }),
    db.campaign.findMany({ where: { status: { in: ['GENERATING', 'REVIEW', 'ACTIVE'] } }, orderBy: { createdAt: 'desc' }, take: 100, include: { student: { select: { fullName: true } } } }),
    db.email.count({ where: { status: 'CANCELLED', gmailDraftId: { not: null } } }),
  ]);
  const counts = await campaignCounts(campaigns.map((c) => c.id));
  const all = ['writing', 'sending', 'inbox'] as ('writing' | 'sending' | 'inbox')[];
  const stoppedAll = st.writing && st.sending && st.inbox;
  return (
    <>
      <AutoRefresh seconds={5} />
      <Head title="Control" sub="Stop, resume or cancel the work">
        {stoppedAll ? null : <ActionButton action={A.setStops.bind(null, all, true)} label="Stop everything" tone="danger" />}
        {st.writing || st.sending || st.inbox ? <ActionButton action={A.setStops.bind(null, all, false)} label="Resume everything" /> : null}
      </Head>
      <div className="cols">
        {JOBS.map(([k, name, what]) => (
          <section className="card" key={k}>
            <div className="between"><h2>{name}</h2>{st[k] ? <Chip s="FAILED" text="Stopped" /> : (k === 'writing' ? worker.ai : worker.email) ? <Chip s="READY" text="Running" /> : <Chip s="FAILED" text="Worker is off" />}</div>
            <p className="muted small">{what}</p>
            <ActionButton action={A.setStops.bind(null, [k], !st[k])} label={st[k] ? 'Resume' : 'Stop'} tone={st[k] ? undefined : 'danger'} />
          </section>
        ))}
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Right now</h2>
        {now.length ? now.map((e) => <p key={e.id}>Row {e.professor.rowNumber}: <Link href={`/emails/${e.id}`}>{e.professor.name}</Link> for {e.student.fullName}. <b>{e.step ?? (e.status === 'SENDING' ? 'Sending' : 'Writing')}</b></p>) : <p className="muted">No email is being worked on.</p>}
        {next ? <p>Next to be sent: <Link href={`/emails/${next.id}`}>{next.professor.name}</Link>, {when(next.scheduledFor)} ({inTime(next.scheduledFor)}). <Link href="/schedule">See the whole schedule</Link></p> : <p className="muted">Nothing is scheduled.</p>}
        {leftover ? <p className="muted">{leftover} drafts of cancelled emails are still to be removed from Gmail.</p> : null}
      </section>
      <section className="card scroll">
        <h2>Campaigns</h2>
        {campaigns.length ? (
          <table>
            <thead><tr><th>Campaign</th><th>Student</th><th>State</th><th>Waiting</th><th>To review</th><th>Scheduled</th><th>Sent</th><th /></tr></thead>
            <tbody>
              {campaigns.map((c) => {
                const k = counts.get(c.id) ?? {};
                return (
                  <tr key={c.id}>
                    <td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td>{c.student.fullName}</td>
                    <td>{c.paused ? <Chip s="-" text="Paused" /> : <Chip s={c.status} />}</td>
                    <td className="num">{(k.PENDING ?? 0) + (k.GENERATING ?? 0)}</td>
                    <td className="num">{k.DRAFT ?? 0}</td>
                    <td className="num">{k.SCHEDULED ?? 0}</td>
                    <td className="num">{(k.SENT ?? 0) + (k.BOUNCED ?? 0)}</td>
                    <td>
                      <span className="row">
                        <ActionButton action={A.pauseCampaign.bind(null, c.id, !c.paused)} label={c.paused ? 'Resume' : 'Pause'} />
                        <ActionButton action={A.cancelCampaign.bind(null, c.id)} label="Cancel" tone="danger" confirm="Cancel this campaign for good? Everything not sent is cancelled and its drafts are removed from Gmail. Sent emails stay." />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No open campaigns.</p>}
      </section>
    </>
  );
}
