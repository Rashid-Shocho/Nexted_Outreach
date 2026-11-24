import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireStaff } from '@/lib/auth';
import { stops } from '@/lib/db';
import { env, sandboxAllow, sandboxMissing } from '@/lib/env';
import { restartNeeded, unreadCount, workerState } from '@/lib/queries';
import { logout } from '../actions';
import { Nav } from '@/components/nav';
import { AutoRefresh } from '@/components/client';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const [unread, paused, worker, restart] = await Promise.all([unreadCount(), stops(), workerState(), restartNeeded()]);
  const e = env();
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <Link href="/students" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/branding/nexted-icon-64.png" width={28} height={28} alt="" /> Outreach
        </Link>
        <Nav unread={unread} />
        <div className="foot">
          <div className="who">{staff.name}</div>
          <form action={logout}><button className="btn quiet small" style={{ marginTop: 6, padding: '4px 12px' }}>Sign out</button></form>
        </div>
      </nav>
      <main className="main">
        {paused.sending || paused.writing || paused.inbox ? <div className="banner stop">Stopped on the <Link href="/control">Control</Link> page: {[paused.writing && 'writing', paused.sending && 'scheduling and sending', paused.inbox && 'reading mail'].filter(Boolean).join(', ')}.</div> : null}
        {!worker.email || !worker.ai ? (
          <div className="banner stop">
            The worker is not running, so {!worker.email && !worker.ai ? 'nothing is written, drafted, sent or received' : worker.email ? 'no emails are written' : 'nothing is drafted, sent or received'}. Start it with: npm run worker
          </div>
        ) : null}
        {worker.email && worker.ai && (restart.worker || restart.website) ? <div className="banner stop">Settings or code changed after the {[restart.website && 'website', restart.worker && 'worker'].filter(Boolean).join(' and the ')} started, so old behaviour is still in use. Press Ctrl + C in {restart.website && restart.worker ? 'both windows' : 'that window'} and start {restart.website && restart.worker ? 'both' : 'it'} again.</div> : null}
        {sandboxMissing() ? <div className="banner stop">No test inbox yet: set EMAIL_SANDBOX_TO in the .env file to an address you can open, then restart the website and the worker. Until then nothing is drafted or sent.</div> : null}
        {!e.EMAIL_SANDBOX ? <div className="banner stop">Real sending is switched on. Campaigns marked LIVE send to the addresses in their list; all others still go to {e.EMAIL_SANDBOX_TO}.</div> : null}
        {e.EMAIL_SANDBOX && !sandboxMissing() ? (
          <div className="banner">
            Test mode: every email goes to {e.EMAIL_SANDBOX_TO}, not to professors.{sandboxAllow().length ? ` Only your own test addresses get their email themselves: ${sandboxAllow().join(', ')}.` : ''}
            {e.EMAIL_TRANSPORT === 'fake' ? ' Gmail is simulated.' : ''}
            {e.LLM_PROVIDER === 'mock' ? ' The AI is simulated.' : ''}
          </div>
        ) : null}
        {children}
      </main>
      <AutoRefresh seconds={30} />
    </div>
  );
}
