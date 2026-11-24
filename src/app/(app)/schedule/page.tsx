import Link from 'next/link';
import { DateTime } from 'luxon';
import { requireStaff } from '@/lib/auth';
import { db, stops } from '@/lib/db';
import { workerState } from '@/lib/queries';
import { AutoRefresh } from '@/components/client';
import { Chip, Head, inTime } from '@/components/ui';

export const metadata = { title: 'Schedule' };
const TZ = 'Asia/Dhaka';

export default async function Schedule({ searchParams }: { searchParams: Promise<{ student?: string }> }) {
  await requireStaff();
  const { student } = await searchParams;
  const now = DateTime.now().setZone(TZ);
  const [rows, st, worker, students, total] = await Promise.all([
    db.email.findMany({
      where: { ...(student ? { studentId: student } : {}), OR: [{ status: { in: ['SCHEDULED', 'SENDING', 'UNCERTAIN'] } }, { status: { in: ['SENT', 'BOUNCED'] }, sentAt: { gte: now.startOf('day').toJSDate() } }] },
      orderBy: { scheduledFor: 'asc' },
      take: 400,
      include: { professor: { select: { name: true, university: true } }, student: { select: { fullName: true } }, campaign: { select: { paused: true, status: true } } },
    }),
    stops(),
    workerState(),
    db.student.findMany({ where: { emails: { some: { status: 'SCHEDULED' } } }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } }),
    db.email.count({ where: { status: 'SCHEDULED', ...(student ? { studentId: student } : {}) } }),
  ]);
  const at = (e: (typeof rows)[0]) => e.sentAt ?? e.scheduledFor!;
  const days = new Map<string, typeof rows>();
  for (const e of [...rows].sort((a, b) => at(a).getTime() - at(b).getTime())) {
    const k = DateTime.fromJSDate(at(e)).setZone(TZ).toISODate()!;
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  const next = rows.find((e) => e.status === 'SCHEDULED' && !e.campaign.paused);
  return (
    <>
      <AutoRefresh seconds={10} />
      <Head title="Schedule" sub={`${total} emails waiting for their time (${TZ})`}>
        <form className="row">
          <select name="student" defaultValue={student ?? ''} aria-label="Student" style={{ width: 200 }}><option value="">All students</option>{students.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select>
          <button className="btn quiet">Show</button>
        </form>
      </Head>
      <section className="card">
        {next ? <p><b>Next: {DateTime.fromJSDate(next.scheduledFor!).setZone(TZ).toFormat('cccc d LLL, HH:mm')}</b> ({inTime(next.scheduledFor)}), to {next.professor.name} for {next.student.fullName}</p> : <p>Nothing is waiting.</p>}
        <p className="muted small" style={{ margin: 0 }}>
          {st.sending ? 'Sending is stopped on the Control page. ' : worker.email ? 'The sender is running. ' : 'The sender is off: start the worker. '}
          This page is the schedule. In Gmail the emails stay under Drafts until their time, because Google does not let other programs use Gmail’s own “Scheduled” folder.
        </p>
      </section>
      {[...days].map(([k, list]) => (
        <section className="card scroll" key={k}>
          <h2>{DateTime.fromISO(k, { zone: TZ }).toFormat('cccc d LLLL')} <span className="muted small">{list.length} emails</span></h2>
          <table>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td className="num" style={{ width: 70 }}>{DateTime.fromJSDate(at(e)).setZone(TZ).toFormat('HH:mm')}</td>
                  <td><Link href={`/emails/${e.id}`}>{e.professor.name}</Link><div className="muted small">{e.professor.university}</div></td>
                  <td>{e.student.fullName}</td>
                  <td><span className="row"><Chip s={e.status} />{e.campaign.paused ? <Chip s="-" text="Paused" /> : null}</span></td>
                  <td className="muted small">{e.status === 'SCHEDULED' ? (e.gmailDraftId ? 'draft in Gmail' : 'draft not in Gmail yet') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
