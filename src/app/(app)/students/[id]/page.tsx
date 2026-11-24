import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DateTime } from 'luxon';
import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { OLD_ENOUGH, tooNewText } from '@/lib/pipeline/account';
import { MIN_ABOUT } from '@/lib/pipeline/campaigns';
import { campaignCounts } from '@/lib/queries';
import * as A from '../../../actions';
import { ActionButton, ActionForm, AutoRefresh } from '@/components/client';
import { batches, scrub } from '@/lib/pipeline/profile';
import { Chip, Head, ScheduleFields, when } from '@/components/ui';

export const metadata = { title: 'Student' };

export default async function Student({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ gmail?: string }> }) {
  await requireStaff();
  const { id } = await params;
  const { gmail } = await searchParams;
  const s = await db.student.findUnique({
    where: { id },
    include: {
      mailbox: true,
      profiles: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, fileName: true, status: true, error: true, brief: true, parts: true, text: true, notBefore: true, createdAt: true } },
      cvs: { orderBy: { version: 'desc' }, select: { id: true, version: true, fileName: true, createdAt: true } },
      lists: { orderBy: { createdAt: 'desc' }, select: { id: true, fileName: true, status: true, _count: { select: { professors: true } } } },
      campaigns: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!s) notFound();
  const counts = await campaignCounts(s.campaigns.map((c) => c.id));
  const cv = s.cvs[0];
  const profile = s.profiles[0];
  const reading = profile?.status === 'PENDING' || profile?.status === 'RUNNING';
  const about = [profile?.status === 'READY' ? profile.brief : '', s.notes].filter(Boolean).join('\n').trim();
  const lists = s.lists.filter((l) => l.status === 'IMPORTED');
  // today while there is still time before the usual window ends, otherwise tomorrow
  const dhaka = DateTime.now().setZone('Asia/Dhaka');
  const firstDay = (dhaka.hour < 19 ? dhaka : dhaka.plus({ days: 1 })).toISODate()!;
  return (
    <>
      <Head title={s.fullName} sub={<>{s.email}{s.isDemo ? ' · demo' : ''}</>} />
      {reading ? <AutoRefresh seconds={4} /> : null}
      {gmail === 'connected' ? <p className="note good">Gmail connected.</p> : gmail ? <p className="note bad">{gmail}</p> : null}
      <div className="cols">
        <section className="card">
          <div className="between"><h2>1. Gmail</h2>{s.mailbox ? <Chip s={s.mailbox.status} /> : <Chip s="-" text="Not connected" />}</div>
          {s.mailbox ? (
            <>
              <p className="muted small">Last checked: {when(s.mailbox.lastSyncAt) || 'not yet'}</p>
              {s.mailbox.oldMessages == null ? null : s.mailbox.oldMessages < OLD_ENOUGH ? <p className="note bad">{tooNewText(s.mailbox.oldMessages)}</p> : <p className="muted small">This Gmail is in normal use and may be used for real sending.</p>}
              {s.mailbox.lastError ? (s.mailbox.status === 'CONNECTED' ? <p className="muted small">Still connected. The last check did not work: {s.mailbox.lastError} It is tried again by itself{s.mailbox.nextSyncAt > new Date() ? ` at ${when(s.mailbox.nextSyncAt)}` : ' in a moment'}.</p> : <p className="note bad">{s.mailbox.lastError}</p>) : null}
              <div className="row">
                <ActionButton action={A.connectGmail.bind(null, id)} label={s.mailbox.status === 'RECONNECT' ? 'Reconnect' : 'Connect again'} />
                <ActionButton action={A.checkMailNow.bind(null, id)} label="Check mail now" />
                <ActionButton action={A.disconnectGmail.bind(null, id)} label="Disconnect" tone="danger" confirm="Stop reading and sending for this student?" />
              </div>
            </>
          ) : (
            <>
              <p className="muted">Sign in as {s.email} on Google’s page and allow access. The password is never seen here.</p>
              <div className="row">
                <ActionForm action={A.connectGmail.bind(null, id)} submit="Connect Gmail" className="inline" />
                <ActionButton action={A.makeConnectLink.bind(null, id)} label="Make a link for the student" />
              </div>
            </>
          )}
        </section>
        <section className="card">
          <div className="between"><h2>2. Profile</h2>{profile ? <Chip s={reading ? 'RUNNING' : profile.status} /> : <Chip s="-" text="None" />}</div>
          {profile ? <p><a href={`/api/profile/${profile.id}`}>{profile.fileName}</a> <span className="muted small">version {profile.version}, {when(profile.createdAt)}</span></p> : null}
          {reading ? <p className="muted small">Reading part {Math.min((profile.parts as unknown[]).length + 1, Math.max(1, batches(scrub(profile.text)).length))} of {batches(scrub(profile.text)).length}.{profile.notBefore && profile.notBefore > new Date() ? ` ${profile.error ?? ''} Next try ${when(profile.notBefore)}.` : ''}</p> : null}
          {profile?.status === 'FAILED' ? <><p className="note bad">{profile.error}</p><ActionButton action={A.retryProfile.bind(null, profile.id)} label="Read again" /></> : null}
          <ActionForm action={A.uploadProfile.bind(null, id)} submit={profile ? 'Upload a new version' : 'Upload Profile'} tone={profile ? 'quiet' : undefined}>
            <label>PDF, up to 8 MB. The emails take their facts from it.<input type="file" name="file" accept="application/pdf,.pdf" required /></label>
          </ActionForm>
        </section>
        <section className="card">
          <div className="between"><h2>3. CV</h2>{cv ? <Chip s="READY" text="Uploaded" /> : <Chip s="-" text="None" />}</div>
          {cv ? <p><a href={`/api/cv/${cv.id}`}>{cv.fileName}</a> <span className="muted small">version {cv.version}, {when(cv.createdAt)}</span></p> : null}
          <ActionForm action={A.uploadCv.bind(null, id)} submit={cv ? 'Upload a new version' : 'Upload CV'} tone={cv ? 'quiet' : undefined}>
            <label>PDF, up to 8 MB. It is attached to every draft.<input type="file" name="file" accept="application/pdf,.pdf" required /></label>
          </ActionForm>
        </section>
        <section className="card">
          <h2>4. Professor lists</h2>
          {s.lists.map((l) => (
            <p key={l.id} className="between"><Link href={`/lists/${l.id}`}>{l.fileName}</Link><span className="row"><span className="muted small">{l._count.professors || ''}</span><Chip s={l.status} /></span></p>
          ))}
          <ActionForm action={A.uploadList.bind(null, id)} submit="Read Google Sheet" tone={s.lists.length ? 'quiet' : undefined} keep>
            <label>Google Sheets link (shared as “Anyone with the link: Viewer”)<input name="link" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" required /></label>
          </ActionForm>
          <div style={{ height: 14 }} />
          <ActionForm action={A.uploadList.bind(null, id)} submit="Upload file" tone="quiet">
            <label>or a file: Excel (.xlsx) or .csv<input type="file" name="file" accept=".xlsx,.csv" required /></label>
          </ActionForm>
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2>5. Campaigns</h2>
        {s.campaigns.length ? (
          <div className="scroll">
            <table>
              <thead><tr><th>Name</th><th>Status</th><th>To review</th><th>Scheduled</th><th>Sent</th></tr></thead>
              <tbody>
                {s.campaigns.map((c) => {
                  const k = counts.get(c.id) ?? {};
                  return (
                    <tr key={c.id}>
                      <td><Link href={`/campaigns/${c.id}`}>{c.name}</Link></td>
                      <td>{c.paused ? <Chip s="-" text="Paused" /> : <Chip s={c.status} />}</td>
                      <td className="num">{k.DRAFT ?? 0}</td>
                      <td className="num">{k.SCHEDULED ?? 0}</td>
                      <td className="num">{(k.SENT ?? 0) + (k.BOUNCED ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {s.cvs.length && lists.length && !reading && about.length >= MIN_ABOUT && s.phone ? (
          <details open={!s.campaigns.length}>
            <summary style={{ cursor: 'pointer', margin: '10px 0', fontWeight: 500 }}>New campaign</summary>
            <ActionForm action={A.createCampaign.bind(null, id)} submit="Write the emails" keep>
              <div className="grid3">
                <label>Professor list<select name="listId">{lists.map((l) => <option key={l.id} value={l.id}>{l.fileName} ({l._count.professors})</option>)}</select></label>
                <label>CV<select name="cvId">{s.cvs.map((c) => <option key={c.id} value={c.id}>Version {c.version}: {c.fileName}</option>)}</select></label>
                <label>Campaign name<input name="name" placeholder="Same as the list" /></label>
                <label>Intake (optional)<input name="intake" placeholder="Fall 2027" /></label>
              </div>
              <label>Instructions for the writer (optional)<textarea name="instructions" rows={2} placeholder="For example: mention that the student has full funding." /></label>
              <label className="check"><input type="checkbox" name="autoSchedule" defaultChecked />Schedule each email by itself as soon as it is written and passes the checks (without reading it first)</label>
              <label className="check"><input type="checkbox" name="replace" />Replace emails not sent yet: professors who already have an unsent email from this student are written again here</label>
              {env().EMAIL_SANDBOX ? null : (
                <fieldset>
                  <legend>Test or real?</legend>
                  <label className="check"><input type="radio" name="mode" value="test" required />Test: own test addresses get a [TEST] subject, everybody else’s email goes to {env().EMAIL_SANDBOX_TO}. Test emails often land in Spam.</label>
                  <label className="check"><input type="radio" name="mode" value="real" required />Real: emails go to the addresses in the list</label>
                  <label>For Real, type LIVE here<input name="live" autoComplete="off" /></label>
                  <label className="check"><input type="checkbox" name="slowStart" defaultChecked />Slow start against Spam: at most 3 a day for three days, then 5, then 10, full number after two weeks. Untick only when this Gmail has been in normal use for months.</label>
                </fieldset>
              )}
              <ScheduleFields v={{ startDate: firstDay, windowStart: '19:30', windowEnd: '20:30', timezone: 'Asia/Dhaka', minPerDay: 15, maxPerDay: 20, weekdays: [1, 2, 3, 4, 5] }} />
            </ActionForm>
          </details>
        ) : <p className="muted">A campaign needs: {[!s.cvs.length && 'a CV', !lists.length && 'an imported professor list', reading ? 'the Profile to be read (a moment)' : about.length < MIN_ABOUT && 'the Profile PDF', !s.phone && 'the phone number (below)'].filter(Boolean).join(', ')}.</p>}
      </section>

      {profile?.status === 'READY' ? (
        <section className="card">
          <h2>Brief from the Profile</h2>
          <p className="muted small">This is what the writer knows about the student. Read it once and correct it: every email depends on it. Doubtful, private and “to verify” items of the Profile are left out on purpose.</p>
          <ActionForm key={profile.id} action={A.saveBrief.bind(null, profile.id)} submit="Save brief" tone="quiet" keep>
            <label>Brief<textarea name="brief" rows={18} defaultValue={profile.brief ?? ''} /></label>
          </ActionForm>
        </section>
      ) : null}

      <section className="card">
        <h2>Details</h2>
        <p className="muted small">The emails take their facts from the Profile and these notes. The CV is attached but not read.</p>
        <ActionForm action={A.updateStudent.bind(null, id)} submit="Save" tone="quiet" keep>
          <div className="grid3">
            <label>Full name<input name="fullName" defaultValue={s.fullName} required /></label>
            <label>Phone (shown in the emails)<input name="phone" defaultValue={s.phone ?? ''} /></label>
          </div>
          <label>Signature lines under the name (optional): position, department, institution<textarea name="signature" rows={3} defaultValue={s.signature ?? ''} /></label>
          <label>Extra notes for the emails (optional)<textarea name="notes" rows={3} defaultValue={s.notes ?? ''} /></label>
          <label className="check"><input type="checkbox" name="consent" defaultChecked={!!s.consentAt} />Written consent recorded{s.consentAt ? ` (${when(s.consentAt)}, ${s.consentBy})` : ''}</label>
        </ActionForm>
      </section>
    </>
  );
}
