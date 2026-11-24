import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { testMode } from '@/lib/env';
import { campaignCounts } from '@/lib/queries';
import { Chip, Head } from '@/components/ui';

export const metadata = { title: 'Campaigns' };

export default async function Campaigns() {
  await requireStaff();
  const rows = await db.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { student: { select: { fullName: true } } } });
  const counts = await campaignCounts(rows.map((r) => r.id));
  return (
    <>
      <Head title="Campaigns" sub="The newest 200, for all students" />
      <div className="card scroll">
        {rows.length ? (
          <table>
            <thead><tr><th>Campaign</th><th>Student</th><th>Status</th><th>To review</th><th>Scheduled</th><th>Sent</th><th>Needs a look</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const k = counts.get(c.id) ?? {};
                return (
                  <tr key={c.id}>
                    <td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td>{c.student.fullName}</td>
                    <td><span className="row">{c.paused ? <Chip s="-" text="Paused" /> : <Chip s={c.status} />}{!testMode(c.live) ? <Chip s="FAILED" text="LIVE" /> : null}</span></td>
                    <td className="num">{k.DRAFT ?? 0}</td>
                    <td className="num">{k.SCHEDULED ?? 0}</td>
                    <td className="num">{(k.SENT ?? 0) + (k.BOUNCED ?? 0)}</td>
                    <td className="num">{(k.UNCERTAIN ?? 0) + (k.GEN_FAILED ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No campaigns yet. Open a student to start one.</p>}
      </div>
    </>
  );
}
