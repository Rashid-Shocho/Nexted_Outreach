import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { blocked } from '@/lib/checks';
import * as A from '../../../actions';
import { ActionButton, ActionForm, AutoRefresh } from '@/components/client';
import { testMode } from '@/lib/env';
import { papersOf } from '@/lib/pipeline/drafting';
import { Chip, FIT, Flags, Head, inTime, when } from '@/components/ui';

export const metadata = { title: 'Email' };

export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  const e = await db.email.findUnique({ where: { id }, include: { professor: true, campaign: true, student: { select: { fullName: true } } } });
  if (!e) notFound();
  const thread = e.gmailThreadId
    ? await db.thread.findUnique({ where: { studentId_gmailThreadId: { studentId: e.studentId, gmailThreadId: e.gmailThreadId } }, select: { id: true, hasIncoming: true } })
    : null;
  const editable = ['DRAFT', 'SCHEDULED', 'GEN_FAILED'].includes(e.status);
  const p = e.professor;
  return (
    <>
      {['PENDING', 'GENERATING', 'SENDING'].includes(e.status) ? <AutoRefresh seconds={3} /> : null}
      <Head title={p.name} sub={<><Link href={`/campaigns/${e.campaignId}`}>{e.campaign.name}</Link> · {e.student.fullName}</>}>
        {!testMode(e.campaign.live) ? <Chip s="FAILED" text="LIVE" /> : null}
        <Chip s={e.status} />
        {e.repliedAt ? <Chip s="SENT" text="Replied" /> : null}
      </Head>
      {e.error ? <p className="note bad" style={{ marginBottom: 16 }}>{e.error}</p> : null}
      {e.draftError && !e.gmailDraftId ? <p className="note bad" style={{ marginBottom: 16 }}>Gmail draft: {e.draftError}</p> : null}
      <div className="mail">
        <section className="card">
          {editable ? (
            <ActionForm key={e.contentVersion} action={A.saveEmail.bind(null, id)} submit="Save changes" tone="quiet" keep>
              <label>To<input value={e.toEmail} readOnly /></label>
              <label>Subject<input name="subject" defaultValue={e.subject} required /></label>
              <label>Text (**bold** and *italic* are possible)<textarea name="body" rows={18} defaultValue={e.body} required /></label>
            </ActionForm>
          ) : (
            <>
              <p className="muted">To {e.sentTo ?? e.toEmail}{e.sandboxed && e.sentTo ? ` (test mode, meant for ${e.toEmail})` : ''}</p>
              <h2>{e.subject}</h2>
              <div className="mailtext">{e.body}</div>
            </>
          )}
        </section>
        <section className="card">
          {e.scheduledFor && e.status === 'SCHEDULED' ? (
            <p><b>Will be sent</b> {when(e.scheduledFor, e.campaign.timezone)} ({inTime(e.scheduledFor)})<br /><span className="muted small">{e.gmailDraftId ? 'The draft is in Gmail (under Drafts); this system sends it at that time' : 'The draft is being put into Gmail'}</span></p>
          ) : null}
          {e.sentAt ? <p><b>Sent</b> {when(e.sentAt, e.campaign.timezone)}</p> : null}
          {thread?.hasIncoming ? <p><Link className="btn" href={`/inbox/${thread.id}`}>Open the conversation</Link></p> : null}
          {Array.isArray(e.flags) && e.flags.length ? <><h3>Checks</h3><Flags flags={e.flags} /></> : e.body ? <p className="muted">No problems found by the checks.</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            {e.status === 'SCHEDULED' && testMode(e.campaign.live) && !e.sendNow ? <ActionButton action={A.sendTestNow.bind(null, id)} label="Send now to the test inbox" /> : null}
            {e.status === 'DRAFT' && blocked(e.flags) ? <ActionButton action={A.acceptFlags.bind(null, id)} label="I checked it, it is fine" /> : null}
            {e.status === 'DRAFT' && !blocked(e.flags) && e.campaign.status === 'ACTIVE' ? <ActionButton action={A.scheduleEmail.bind(null, id)} label="Schedule this email" /> : null}
            {e.status === 'CANCELLED' && !e.sentAt && e.campaign.status !== 'CANCELLED' ? <ActionButton action={A.restoreEmail.bind(null, id)} label="Restore" /> : null}
            {['DRAFT', 'GEN_FAILED'].includes(e.status) ? <ActionButton action={A.rewriteEmail.bind(null, id)} label="Write again" confirm="Replace the current text?" /> : null}
            {['DRAFT', 'GEN_FAILED', 'SCHEDULED'].includes(e.status) ? <ActionButton action={A.cancelEmail.bind(null, id)} label="Do not send" tone="danger" confirm="Leave this professor out?" /> : null}
          </div>
          {e.status === 'UNCERTAIN' ? (
            <>
              <p>Look in the student’s Gmail (Sent and Drafts) first, then say what you found.</p>
              <div className="row">
                <ActionButton action={A.resolveUncertain.bind(null, id, 'sent')} label="It was sent" />
                <ActionButton action={A.resolveUncertain.bind(null, id, 'send_again')} label="Not sent: schedule again" confirm="Are you sure it is not in Sent? Otherwise the professor gets it twice." />
                <ActionButton action={A.cancelEmail.bind(null, id)} label="Do not send" tone="danger" />
              </div>
            </>
          ) : null}
          <h3>Professor</h3>
          <p className="small">{[p.email, p.university, p.department, p.country].filter(Boolean).join(' · ')}</p>
          {p.researchArea ? <p className="small"><b>Research:</b> {p.researchArea}</p> : null}
          {p.notes ? <p className="small"><b>Notes:</b> {p.notes}</p> : null}
          {papersOf(p).length ? (
            <>
              <h3>Papers found (Crossref)</h3>
              <ul className="flags">{papersOf(p).map((x) => <li key={x.doi}><a href={`https://doi.org/${x.doi}`} target="_blank" rel="noreferrer">{x.title}</a> <span className="muted">({x.year})</span></li>)}</ul>
            </>
          ) : null}
          {e.fitNote ? <details className="small" style={{ marginTop: 12 }}><summary>Private match note</summary>{e.fit ? `${FIT[e.fit]?.[0] ?? e.fit}. ` : ''}{e.fitNote}</details> : null}
        </section>
      </div>
    </>
  );
}
