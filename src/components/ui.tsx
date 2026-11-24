import { DateTime } from 'luxon';
import type { ReactNode } from 'react';
import type { Flag } from '@/lib/checks';

export const when = (d: Date | null | undefined, tz = 'Asia/Dhaka') => (d ? DateTime.fromJSDate(d).setZone(tz).toFormat('d LLL yyyy, HH:mm') : '');
export const shortWhen = (d: Date, tz = 'Asia/Dhaka') => {
  const t = DateTime.fromJSDate(d).setZone(tz);
  return t.hasSame(DateTime.now().setZone(tz), 'day') ? t.toFormat('HH:mm') : t.toFormat('d LLL');
};

export const inTime = (d: Date | null | undefined) => (d ? (d.getTime() <= Date.now() ? 'now' : (DateTime.fromJSDate(d).toRelative({ locale: 'en' }) ?? '')) : '');

const LABEL: Record<string, [string, string]> = {
  PENDING: ['Waiting', 'soft'],
  GENERATING: ['Writing', 'soft'],
  GEN_FAILED: ['Not written', 'bad'],
  DRAFT: ['To review', 'warn'],
  SCHEDULED: ['Scheduled', 'blue'],
  SENDING: ['Sending', 'blue'],
  SENT: ['Sent', 'good'],
  BOUNCED: ['Bounced', 'bad'],
  UNCERTAIN: ['Needs a look', 'bad'],
  CANCELLED: ['Cancelled', 'soft'],
  REVIEW: ['Review', 'warn'],
  ACTIVE: ['Running', 'good'],
  COMPLETED: ['Finished', 'soft'],
  RUNNING: ['Reading', 'soft'],
  CONNECTED: ['Connected', 'good'],
  RECONNECT: ['Reconnect needed', 'bad'],
  READY: ['Ready', 'good'],
  FAILED: ['Failed', 'bad'],
  PREVIEW: ['Not imported yet', 'warn'],
  IMPORTED: ['Imported', 'good'],
  PROFESSOR: ['Professor', 'good'],
  AUTO_REPLY: ['Auto-reply', 'soft'],
  BOUNCE: ['Bounce', 'bad'],
  OTHER: ['Other', 'soft'],
};

export function Chip({ s, text }: { s: string; text?: string }) {
  const [label, tone] = LABEL[s] ?? [s, 'soft'];
  return <span className={`chip ${tone}`}>{text ?? label}</span>;
}

export const FIT: Record<string, [string, string]> = { strong: ['Strong match', 'good'], some: ['Some match', 'blue'], weak: ['Weak match', 'bad'], unknown: ['Area not given', 'soft'] };

export function Flags({ flags }: { flags: unknown }) {
  const list = Array.isArray(flags) ? (flags as Flag[]) : [];
  if (!list.length) return null;
  return (
    <ul className="flags">
      {list.map((f, i) => (
        <li key={i} className={f.level}>{f.level === 'block' ? 'Must fix: ' : 'Check: '}{f.text}</li>
      ))}
    </ul>
  );
}

export const Head = ({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) => (
  <header className="head">
    <div>
      <h1>{title}</h1>
      {sub ? <p className="muted">{sub}</p> : null}
    </div>
    {children ? <div className="row">{children}</div> : null}
  </header>
);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function ScheduleFields({ v }: { v: { startDate: string; windowStart: string; windowEnd: string; timezone: string; minPerDay: number; maxPerDay: number; weekdays: number[] } }) {
  return (
    <>
      <div className="grid3">
        <label>Start date<input type="date" name="startDate" defaultValue={v.startDate} required /></label>
        <label>From<input type="time" name="windowStart" defaultValue={v.windowStart} required /></label>
        <label>To<input type="time" name="windowEnd" defaultValue={v.windowEnd} required /></label>
        <label>Fewest per day<input type="number" name="minPerDay" min={1} max={50} defaultValue={v.minPerDay} required /></label>
        <label>Most per day<input type="number" name="maxPerDay" min={1} max={50} defaultValue={v.maxPerDay} required /></label>
        <label>Time zone
          <select name="timezone" defaultValue={v.timezone}>
            {[...new Set([v.timezone, 'Asia/Dhaka', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney'])].map((z) => <option key={z}>{z}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="days">
        <legend>Sending days</legend>
        {DAYS.map((d, i) => (
          <label key={d} className="check"><input type="checkbox" name="weekdays" value={i + 1} defaultChecked={v.weekdays.includes(i + 1)} />{d}</label>
        ))}
      </fieldset>
    </>
  );
}
