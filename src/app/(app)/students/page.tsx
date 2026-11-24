import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { addStudent, connectGmail, importStudents } from '../../actions';
import { ActionButton, ActionForm } from '@/components/client';
import { Chip, Head } from '@/components/ui';

export const metadata = { title: 'Students' };
const PAGE = 50;

export default async function Students({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; show?: string }> }) {
  await requireStaff();
  const { q = '', page = '1', show } = await searchParams;
  const n = Math.max(1, Number(page) || 1);
  const todo = show === 'todo';
  const where = { ...(todo ? { OR: [{ mailbox: { is: null } }, { mailbox: { status: 'RECONNECT' as const } }] } : {}), ...(q ? { AND: [{ OR: [{ fullName: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }] }] } : {}) };
  const [rows, total] = await Promise.all([
    db.student.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (n - 1) * PAGE,
      take: PAGE,
      include: { mailbox: { select: { status: true } }, cvs: { orderBy: { version: 'desc' }, take: 1, select: { id: true } }, _count: { select: { campaigns: true } } },
    }),
    db.student.count({ where }),
  ]);
  const waiting = await db.student.count({ where: { OR: [{ mailbox: { is: null } }, { mailbox: { status: 'RECONNECT' } }] } });
  const ids = rows.map((r) => r.id);
  const [counts, replies] = await Promise.all([
    db.email.groupBy({ by: ['studentId', 'status'], where: { studentId: { in: ids } }, _count: { _all: true } }),
    db.email.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, repliedAt: { not: null } }, _count: { _all: true } }),
  ]);
  const num = (id: string, ...st: string[]) => counts.filter((c) => c.studentId === id && st.includes(c.status)).reduce((a, c) => a + c._count._all, 0);
  return (
    <>
      <Head title="Students" sub={`${total} in total`}>
        <form className="row"><input name="q" defaultValue={q} placeholder="Name or Gmail" aria-label="Search students" /></form>
      </Head>
      <nav className="tabs" aria-label="Which students"><Link href="/students" aria-current={todo ? undefined : 'page'}>All</Link><Link href="/students?show=todo" aria-current={todo ? 'page' : undefined}>Gmail to connect ({waiting})</Link></nav>
      <div className="card scroll">
        {rows.length ? (
          <table>
            <thead><tr><th>Student</th><th>Gmail</th><th>CV</th><th>Campaigns</th><th>Scheduled</th><th>Sent</th><th>Replies</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/students/${s.id}`}>{s.fullName}</Link><div className="muted small">{s.email}</div></td>
                  <td>{s.mailbox ? <Chip s={s.mailbox.status} /> : todo ? null : <Chip s="-" text="Not connected" />} {todo ? <ActionButton action={connectGmail.bind(null, s.id)} label="Connect" /> : null}</td>
                  <td>{s.cvs[0] ? <Chip s="READY" text="Uploaded" /> : <Chip s="-" text="None" />}</td>
                  <td className="num">{s._count.campaigns}</td>
                  <td className="num">{num(s.id, 'SCHEDULED', 'SENDING')}</td>
                  <td className="num">{num(s.id, 'SENT', 'BOUNCED')}</td>
                  <td className="num">{replies.find((r) => r.studentId === s.id)?._count._all ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">{q ? 'No student matches.' : 'No students yet. Add the first one below.'}</p>}
        {total > PAGE ? (
          <div className="row" style={{ marginTop: 12 }}>
            {n > 1 ? <Link className="btn quiet" href={`?q=${encodeURIComponent(q)}&page=${n - 1}${todo ? '&show=todo' : ''}`}>Newer</Link> : null}
            {n * PAGE < total ? <Link className="btn quiet" href={`?q=${encodeURIComponent(q)}&page=${n + 1}${todo ? '&show=todo' : ''}`}>Older</Link> : null}
          </div>
        ) : null}
      </div>
      <section className="card">
        <h2>Add a student</h2>
        <ActionForm action={addStudent} submit="Add student" keep>
          <div className="grid3">
            <label>Full name<input name="fullName" required /></label>
            <label>Gmail address<input name="email" type="email" required /></label>
            <label>Phone (shown in the emails)<input name="phone" /></label>
          </div>
          <div className="grid3">
            <label>Profile (PDF): the emails take their facts from it<input type="file" name="profile" accept="application/pdf,.pdf" required /></label>
            <label>CV (PDF): attached to every email<input type="file" name="cv" accept="application/pdf,.pdf" /></label>
          </div>
          <label>Extra notes for the emails (optional)<textarea name="notes" rows={2} /></label>
          <label className="check"><input type="checkbox" name="consent" />The student agreed in writing that we read, draft and send email for them and use AI on their documents</label>
          {env().APP_ENV !== 'production' ? <label className="check"><input type="checkbox" name="demo" />Demo student (made-up data)</label> : null}
        </ActionForm>
      </section>
      <section className="card">
        <h2>Add many students</h2>
        <p className="muted small">An Excel or CSV file with the headings Name, Email, Phone, About. Afterwards open “Gmail to connect”.</p>
        <ActionForm action={importStudents} submit="Add from file" tone="quiet">
          <label>File<input type="file" name="file" accept=".xlsx,.csv" required /></label>
          <label className="check"><input type="checkbox" name="consent" />All of these students agreed in writing</label>
        </ActionForm>
      </section>
    </>
  );
}
