import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { AutoRefresh } from '@/components/client';
import { Chip, Head, shortWhen } from '@/components/ui';

export const metadata = { title: 'Inbox' };
const PAGE = 50;
const VIEWS: [string, string, Prisma.ThreadWhereInput][] = [
  ['professors', 'Professor replies', { kind: 'PROFESSOR' }],
  ['auto', 'Auto-replies', { kind: 'AUTO_REPLY' }],
  ['bounces', 'Bounces', { kind: 'BOUNCE' }],
  ['all', 'All mail', {}],
];

export default async function Inbox({ searchParams }: { searchParams: Promise<{ view?: string; student?: string; unread?: string; q?: string; page?: string }> }) {
  await requireStaff();
  const sp = await searchParams;
  const view = VIEWS.find((v) => v[0] === sp.view) ?? VIEWS[0];
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? '').trim();
  const where: Prisma.ThreadWhereInput = {
    hasIncoming: true,
    ...view[2],
    ...(sp.student ? { studentId: sp.student } : {}),
    ...(sp.unread === '1' ? { unread: true } : {}),
    ...(q ? { OR: [{ subject: { contains: q, mode: 'insensitive' } }, { fromEmail: { contains: q, mode: 'insensitive' } }, { fromName: { contains: q, mode: 'insensitive' } }] } : {}),
  };
  const [threads, total, students] = await Promise.all([
    db.thread.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE, include: { student: { select: { fullName: true } } } }),
    db.thread.count({ where }),
    db.student.findMany({ where: { threads: { some: { hasIncoming: true } } }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } }),
  ]);
  const href = (o: Record<string, string>) =>
    `?${new URLSearchParams({ view: view[0], ...(sp.student ? { student: sp.student } : {}), ...(sp.unread ? { unread: sp.unread } : {}), ...(q ? { q } : {}), ...o })}`;
  return (
    <>
      <AutoRefresh seconds={15} />
      <Head title="Inbox" sub={`One inbox for every connected student${env().INBOX_SCOPE === 'professors' ? ' (professor conversations only)' : ''}`}>
        <form className="row">
          <input type="hidden" name="view" value={view[0]} />
          <select name="student" defaultValue={sp.student ?? ''} aria-label="Student" style={{ width: 180 }}>
            <option value="">All students</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
          <input name="q" defaultValue={q} placeholder="Sender or subject" aria-label="Search" style={{ width: 180 }} />
          <label className="check"><input type="checkbox" name="unread" value="1" defaultChecked={sp.unread === '1'} />Unread</label>
          <button className="btn quiet">Show</button>
        </form>
      </Head>
      <nav className="tabs" aria-label="Kind of mail">
        {VIEWS.map((v) => <Link key={v[0]} href={href({ view: v[0], page: '1' })} aria-current={v === view ? 'page' : undefined}>{v[1]}</Link>)}
      </nav>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {threads.length ? (
          <ul className="threads">
            {threads.map((t) => (
              <li key={t.id}>
                <Link href={`/inbox/${t.id}`} className={t.unread ? 'unread' : undefined}>
                  <span className="cut">{t.fromName ?? t.fromEmail}</span>
                  <span className="cut">{t.subject}<span className="muted" style={{ fontWeight: 400 }}> · {t.snippet}</span></span>
                  <span className="meta">{view[0] === 'all' ? <Chip s={t.kind} /> : null}<Chip s="-" text={t.student.fullName} /><span className="muted small">{shortWhen(t.lastMessageAt)}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="muted" style={{ padding: 20, margin: 0 }}>Nothing here yet.</p>}
      </div>
      {total > PAGE ? (
        <div className="row">
          {page > 1 ? <Link className="btn quiet" href={href({ page: String(page - 1) })}>Newer</Link> : null}
          {page * PAGE < total ? <Link className="btn quiet" href={href({ page: String(page + 1) })}>Older</Link> : null}
        </div>
      ) : null}
    </>
  );
}
