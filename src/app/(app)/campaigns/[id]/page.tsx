import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { env, testMode } from '@/lib/env';
import { blocked } from '@/lib/checks';
import { campaignCounts } from '@/lib/queries';
import * as A from '../../../actions';
import { ActionButton, ActionForm, AutoRefresh } from '@/components/client';
import { Chip, Head, inTime, ScheduleFields, when } from '@/components/ui';

export const metadata = { title: 'Campaign' };
const PAGE = 50;
const TABS: [string, string, Prisma.EmailWhereInput][] = [
  ['all', 'All', {}],
  ['review', 'To review', { status: 'DRAFT' }],
  ['scheduled', 'Scheduled', { status: { in: ['SCHEDULED', 'SENDING'] } }],
  ['sent', 'Sent', { status: 'SENT' }],
  ['replied', 'Replied', { repliedAt: { not: null } }],
  ['look', 'Needs a look', { status: { in: ['UNCERTAIN', 'BOUNCED', 'GEN_FAILED'] } }],
  ['cancelled', 'Cancelled', { status: 'CANCELLED' }],
];

export default async function Campaign({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  const tab = TABS.find((t) => t[0] === sp.tab) ?? TABS[0];
  const page = Math.max(1, Number(sp.page) || 1);
  const c = await db.campaign.findUnique({
    where: { id },
    include: { student: { include: { mailbox: true } }, list: { select: { id: true, fileName: true } }, cv: { select: { id: true, version: true } } },
  });
  if (!c) notFound();
  const where: Prisma.EmailWhereInput = { campaignId: id, ...tab[2] };
  const [k, rows, shown, total, inGmail, replies, drafts, range, waiting, lastHour, working] = await Promise.all([
    campaignCounts([id]).then((m) => m.get(id) ?? {}),
    db.email.findMany({ where, orderBy: tab[0] === 'scheduled' ? { scheduledFor: 'asc' } : { professor: { rowNumber: 'asc' } }, skip: (page - 1) * PAGE, take: PAGE, include: { professor: true } }),
    db.email.count({ where }),
    db.email.count({ where: { campaignId: id } }),
    db.email.count({ where: { campaignId: id, status: 'SCHEDULED', gmailDraftId: { not: null } } }),
    db.email.count({ where: { campaignId: id, repliedAt: { not: null } } }),
    db.email.findMany({ where: { campaignId: id, status: 'DRAFT' }, select: { flags: true } }),
    db.email.aggregate({ where: { campaignId: id, status: 'SCHEDULED' }, _min: { scheduledFor: true }, _max: { scheduledFor: true } }),
    db.email.findFirst({ where: { campaignId: id, status: 'PENDING', notBefore: { gt: new Date() } }, orderBy: { notBefore: 'desc' }, select: { error: true, notBefore: true } }),
    db.apiUsage.findMany({ where: { operation: 'email_draft', success: true, createdAt: { gt: new Date(Date.now() - 20 * 60_000) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    db.email.findFirst({ where: { campaignId: id, OR: [{ step: { not: null } }, { status: 'GENERATING' }] }, include: { professor: { select: { name: true, rowNumber: true } } } }),
  ]);
  const minutes = lastHour.length > 2 ? (Date.now() - lastHour[0].createdAt.getTime()) / 60_000 : 0;
  const pace = minutes > 1 ? Math.max(1, Math.round((lastHour.length / minutes) * 60)) : 0;
  const ready = drafts.filter((d) => !blocked(d.flags)).length;
  const writing = (k.PENDING ?? 0) + (k.GENERATING ?? 0);
  const scheduled = (k.SCHEDULED ?? 0) + (k.SENDING ?? 0);
  const sent = (k.SENT ?? 0) + (k.BOUNCED ?? 0);
  const left = drafts.length + writing + (k.GEN_FAILED ?? 0);
  return (
    <>
      {writing || inGmail < (k.SCHEDULED ?? 0) || k.SENDING ? <AutoRefresh seconds={4} /> : null}
      <Head
        title={c.name}
        sub={<><Link href={`/students/${c.studentId}`}>{c.student.fullName}</Link> · <a href={`/api/cv/${c.cv.id}`}>CV version {c.cv.version}</a> · <Link href={`/lists/${c.list.id}`}>{c.list.fileName}</Link></>}
      >
        {!testMode(c.live) ? <Chip s="FAILED" text="LIVE" /> : <Chip s="REVIEW" text="Test mode" />}
        {c.paused ? <Chip s="-" text="Paused" /> : <Chip s={c.status} />}
        {left + scheduled && c.status !== 'CANCELLED' ? <ActionButton action={A.rewriteAll.bind(null, id)} label="Write all again" confirm="Write every email that is not sent again, with the current rules? Changes made by hand are lost, and they must be approved again." /> : null}
        {['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status) ? <><ActionButton action={A.pauseCampaign.bind(null, id, !c.paused)} label={c.paused ? 'Resume' : 'Pause'} /><ActionButton action={A.cancelCampaign.bind(null, id)} label="Cancel campaign" tone="danger" confirm="Cancel this campaign for good? Everything not sent is cancelled and its drafts are removed from Gmail. Sent emails stay." /></> : null}
      </Head>
      {c.pauseReason ? <p className="note bad" style={{ marginBottom: 16 }}>{c.pauseReason}</p> : null}
      {c.student.mailbox?.status !== 'CONNECTED' ? (
        <p className="note bad" style={{ marginBottom: 16 }}>The student’s Gmail is not connected, so nothing can be drafted or sent. <Link href={`/students/${c.studentId}`}>Open the student</Link></p>
      ) : null}
      <section className="card">
        <div className="stats">
          <div><b>{total}</b><span>professors</span></div>
          <div><b>{left}</b><span>not scheduled yet</span></div>
          <div><b>{scheduled}</b><span>scheduled</span></div>
          <div><b>{inGmail}</b><span>drafts in Gmail</span></div>
          <div><b>{sent}</b><span>sent</span></div>
          <div><b>{replies}</b><span>replies</span></div>
          {k.BOUNCED ? <div><b>{k.BOUNCED}</b><span>bounced</span></div> : null}
          {k.UNCERTAIN ? <div><b>{k.UNCERTAIN}</b><span>need a look</span></div> : null}
        </div>
        <div className="bar" role="img" aria-label={`${sent} of ${total} sent`}><i style={{ width: `${total ? (sent / total) * 100 : 0}%` }} /></div>
        {working ? <p style={{ marginTop: 10, marginBottom: 0 }}>Row {working.professor.rowNumber}: <b>{working.professor.name}</b>. {working.step ?? 'Writing'}…</p> : null}
        {writing ? <p className="muted" style={{ marginTop: 10 }}>{c.status === 'CANCELLED' ? 'Cancelled' : c.paused ? 'Paused' : 'One professor after the other'}: {total - writing} of {total} done{pace ? `, about ${pace} an hour` : ''}…{waiting ? ` ${waiting.error ?? ''} Next try about ${when(waiting.notBefore, c.timezone)}.` : ''}</p> : null}
        {c.skipped ? <p className="muted small" style={{ marginTop: 10 }}>{c.skipped} left out: this student already has an email to them.</p> : null}
        {scheduled ? (
          <p className="note good" style={{ marginTop: 12 }}>
            {left ? `${scheduled} have a send time so far.` : `All ${scheduled} have a send time.`} Next: <b>{when(range._min.scheduledFor, c.timezone)}</b> ({inTime(range._min.scheduledFor)}), last: {when(range._max.scheduledFor, c.timezone)} ({c.timezone}). {inGmail} of {k.SCHEDULED ?? 0} drafts are in Gmail.
            <br />In Gmail they stay under <b>Drafts</b>, because Google does not let other programs use its own “Scheduled” folder. This system sends each draft at its time; the website and the worker must be running then.
          </p>
        ) : null}
        {['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status) ? <div className="between" style={{ marginTop: 12 }}><span className="muted small">{c.autoSchedule ? 'Automatic scheduling is on: each email gets its send time and its Gmail draft as soon as it passes the checks.' : 'Automatic scheduling is off: emails wait for “Approve and schedule”.'}</span><ActionButton action={A.setAutoSchedule.bind(null, id, !c.autoSchedule)} label={c.autoSchedule ? 'Turn automatic off' : 'Schedule automatically'} confirm={c.autoSchedule ? undefined : 'Schedule every email of this campaign that passes the checks, now and later, without reading it first?'} /></div> : null}
        {ready && c.status !== 'CANCELLED' ? (
          <div style={{ marginTop: 14 }}>
            <p className="muted small">
              Read a sample first. {writing ? 'The rest is still being written and can be approved later. ' : ''}{drafts.length - ready ? `${drafts.length - ready} must be fixed and are not included. ` : ''}
              After this they are sent by themselves at {c.windowStart} to {c.windowEnd} ({c.timezone}), {c.minPerDay} to {c.maxPerDay} per sending day.
            </p>
            <ActionForm action={A.approveCampaign.bind(null, id)} submit={`Approve and schedule ${ready}`} confirm={`Approve ${ready} emails for automatic sending?`} />
          </div>
        ) : null}
      </section>
      {['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status) && testMode(c.live) && !env().EMAIL_SANDBOX ? <p className="note bad" style={{ marginBottom: 16 }}>This campaign is in TEST mode. Nothing goes to professors; subjects carry [TEST] or [SANDBOX], which often lands in Spam. Switch it to real sending below if that is what you want.</p> : null}
      {['GENERATING', 'REVIEW', 'ACTIVE'].includes(c.status) ? (
        <section className="card">
          {!testMode(c.live) ? (
            <div className="between">
              <span><b>LIVE.</b> Emails of this campaign go to the real addresses in the list, from {c.student.email}.</span>
              <ActionForm action={A.setLive.bind(null, id, false)} submit="Back to test mode" tone="quiet" className="inline" />
              <span className="muted small">{c.slowStart ? 'Slow start is on: at most 3 a day for three days, then 5, then 10, full number after two weeks.' : 'Slow start is off.'}</span>
              <ActionForm action={A.setSlowStart.bind(null, id, !c.slowStart)} submit={c.slowStart ? 'Turn slow start off' : 'Turn slow start on'} tone="quiet" className="inline" />
            </div>
          ) : env().EMAIL_SANDBOX ? (
            <p className="muted small" style={{ margin: 0 }}>Test mode: emails go to {env().EMAIL_SANDBOX_TO}. Real sending is switched off in the settings.</p>
          ) : (
            <details>
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Test mode. Switch this campaign to real sending</summary>
              <p style={{ marginTop: 10 }}>{total - sent - (k.CANCELLED ?? 0)} emails not sent yet will go from <b>{c.student.email}</b> to the real addresses in <b>{c.list.fileName}</b>. {c.autoSchedule ? 'They are sent by themselves at their time, without anybody reading them first.' : ''} A sent email cannot be taken back.</p>
              <ActionForm action={A.setLive.bind(null, id, true)} submit="Send for real" tone="danger">
                <label>Type LIVE<input name="live" autoComplete="off" required /></label>
              </ActionForm>
            </details>
          )}
        </section>
      ) : null}
      <details className="card">
        <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Schedule: {c.windowStart} to {c.windowEnd} {c.timezone}, {c.minPerDay} to {c.maxPerDay} per day, from {c.startDate}</summary>
        <div style={{ marginTop: 14 }}>
          <ActionForm action={A.saveSchedule.bind(null, id)} submit="Save schedule" tone="quiet" keep confirm={scheduled ? 'Emails not yet sent will get new times. Continue?' : undefined}>
            <ScheduleFields v={c} />
          </ActionForm>
        </div>
      </details>
      <nav className="tabs" aria-label="Emails">
        {TABS.map((t) => <Link key={t[0]} href={`?tab=${t[0]}`} aria-current={t === tab ? 'page' : undefined}>{t[1]}</Link>)}
      </nav>
      <div className="card scroll">
        {rows.length ? (
          <table>
            <thead><tr><th>Professor</th><th>Subject</th><th>Status</th><th>Sends at ({c.timezone})</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.professor.name}<div className="muted small">{e.professor.university ?? e.toEmail}</div></td>
                  <td><Link href={`/emails/${e.id}`}>{e.subject || '(not written yet)'}</Link></td>
                  <td>
                    <span className="row">
                      <Chip s={e.status} />
                      {blocked(e.flags) && e.status === 'DRAFT' ? <Chip s="FAILED" text="Must fix" /> : null}
                      {e.repliedAt ? <Chip s="SENT" text="Replied" /> : null}
                    </span>
                  </td>
                  <td className="num">{when(e.sentAt ?? e.scheduledFor, c.timezone)}{e.status === 'SCHEDULED' ? <div className="muted small">{inTime(e.scheduledFor)} · {e.gmailDraftId ? 'draft in Gmail' : 'draft not in Gmail yet'}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">Nothing here.</p>}
        {shown > PAGE ? (
          <div className="row" style={{ marginTop: 12 }}>
            {page > 1 ? <Link className="btn quiet" href={`?tab=${tab[0]}&page=${page - 1}`}>Back</Link> : null}
            <span className="muted small">{(page - 1) * PAGE + 1} to {Math.min(page * PAGE, shown)} of {shown}</span>
            {page * PAGE < shown ? <Link className="btn quiet" href={`?tab=${tab[0]}&page=${page + 1}`}>Next</Link> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
