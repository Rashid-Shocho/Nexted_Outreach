import { DateTime } from 'luxon';

/** Pure scheduling rules: no database, no clock of its own. */

export interface SchedulePlan {
  startDate: string; // yyyy-mm-dd, in `timezone`
  windowStart: string; // HH:mm
  windowEnd: string;
  timezone: string;
  minPerDay: number;
  maxPerDay: number;
  weekdays: number[]; // 1 = Monday ... 7 = Sunday
  /** Slow start: the day of the first real email (yyyy-mm-dd) */
  slowFrom?: string | null;
}

/** Most emails on one day while a Gmail account is being built up: 3 for three days, 5 until a week, 10 until two weeks. */
export function slowCap(day: string, slowFrom: string | null | undefined): number {
  if (!slowFrom) return Infinity;
  const n = Math.round(DateTime.fromISO(day, { zone: 'utc' }).diff(DateTime.fromISO(slowFrom, { zone: 'utc' }), 'days').days);
  return n < 3 ? 3 : n < 7 ? 5 : n < 14 ? 10 : Infinity;
}

const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export function planProblems(p: SchedulePlan): string[] {
  const out: string[] = [];
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!DateTime.fromISO(p.startDate).isValid || !/^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) out.push('Choose a valid start date.');
  if (!hm.test(p.windowStart) || !hm.test(p.windowEnd)) out.push('Times must look like 19:30.');
  else if (p.windowEnd <= p.windowStart) out.push('The end time must be after the start time.');
  else if (minutesOf(p.windowEnd) - minutesOf(p.windowStart) < 10) out.push('Give the sending time at least 10 minutes from start to end; emails are never sent all at once.');
  if (!DateTime.local().setZone(p.timezone).isValid) out.push('Unknown time zone.');
  if (!Number.isInteger(p.minPerDay) || !Number.isInteger(p.maxPerDay) || p.minPerDay < 1) out.push('Emails per day must be whole numbers.');
  else if (p.maxPerDay < p.minPerDay) out.push('The daily maximum must be at least the minimum.');
  else if (p.maxPerDay > 50) out.push('At most 50 emails per day per student.');
  if (!p.weekdays.length || p.weekdays.some((d) => d < 1 || d > 7)) out.push('Choose at least one sending day.');
  return out;
}

export const dayKey = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toISODate()!;

const at = (day: DateTime, hm: string) => {
  const [hour, minute] = hm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
};

export function windowOf(day: string, p: SchedulePlan) {
  const d = DateTime.fromISO(day, { zone: p.timezone });
  return { start: at(d, p.windowStart), end: at(d, p.windowEnd) };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The next free send time for one email. Each day has its own number between min and max (the same
 * every time it is asked), and the moment farthest from the student's other emails of that day is taken.
 */
export function nextSlot(p: SchedulePlan, opts: { now: Date; taken: Date[]; seed: string; rng?: () => number }): Date {
  const problems = planProblems(p);
  if (problems.length) throw new Error(problems.join(' '));
  const rng = opts.rng ?? Math.random;
  const now = DateTime.fromJSDate(opts.now).setZone(p.timezone);
  const byDay = new Map<string, number[]>();
  for (const t of opts.taken) byDay.set(dayKey(t, p.timezone), [...(byDay.get(dayKey(t, p.timezone)) ?? []), t.getTime()]);
  let day = DateTime.max(DateTime.fromISO(p.startDate, { zone: p.timezone }), now.startOf('day'));
  for (let guard = 0; guard < 3660; guard++, day = day.plus({ days: 1 })) {
    if (!p.weekdays.includes(day.weekday)) continue;
    const key = day.toISODate()!;
    const w = windowOf(key, p);
    const start = now > w.start ? now.plus({ minutes: 3 }) : w.start; // time to put the draft into Gmail first
    const length = w.end.diff(start).toMillis();
    const share = length / w.end.diff(w.start).toMillis();
    const there = byDay.get(key) ?? [];
    const target = Math.min(slowCap(key, p.slowFrom), p.minPerDay + (hash(`${opts.seed}:${key}`) % (p.maxPerDay - p.minPerDay + 1)));
    if (share < 0.1 || there.length >= Math.floor(target * share)) continue;
    let best = 0;
    let far = -1;
    for (let i = 0; i < 60; i++) {
      const t = start.toMillis() + Math.floor(length * (0.01 + 0.97 * rng()));
      const d = there.length ? Math.min(...there.map((x) => Math.abs(x - t))) : length * rng();
      if (d > far) {
        far = d;
        best = t;
      }
    }
    return new Date(best);
  }
  throw new Error('No free sending day within ten years.');
}

/** True when `now` is inside the sending window of an allowed day. */
export function insideWindow(now: Date, p: SchedulePlan): boolean {
  const n = DateTime.fromJSDate(now).setZone(p.timezone);
  if (!p.weekdays.includes(n.weekday)) return false;
  const w = windowOf(n.toISODate()!, p);
  return n >= w.start && n < w.end;
}

/**
 * Gives `count` send times. Each day gets a random number between min and max, less what the
 * student already has that day (`used`, keyed yyyy-mm-dd). Times are spread over the window,
 * one random moment in each equal part, so two emails never leave together.
 * `fill` uses the daily maximum instead (for emails that missed their day).
 */
export function allocateSlots(
  count: number,
  p: SchedulePlan,
  opts: { now: Date; used?: Map<string, number>; rng?: () => number; fill?: boolean; notBefore?: string },
): Date[] {
  const problems = planProblems(p);
  if (problems.length) throw new Error(problems.join(' '));
  const rng = opts.rng ?? Math.random;
  const now = DateTime.fromJSDate(opts.now).setZone(p.timezone);
  let day = DateTime.max(DateTime.fromISO(p.startDate, { zone: p.timezone }), now.startOf('day'));
  if (opts.notBefore) day = DateTime.max(day, DateTime.fromISO(opts.notBefore, { zone: p.timezone }));

  const out: Date[] = [];
  for (let guard = 0; out.length < count; guard++, day = day.plus({ days: 1 })) {
    if (guard > 3660) throw new Error('Could not place every email within ten years.');
    if (!p.weekdays.includes(day.weekday)) continue;
    const key = day.toISODate()!;
    const w = windowOf(key, p);
    const start = now > w.start ? now.plus({ seconds: 30 }) : w.start;
    const share = w.end.diff(start).toMillis() / w.end.diff(w.start).toMillis();
    if (share < 0.1) continue; // the window is over, or nearly
    const target = Math.min(slowCap(key, p.slowFrom), opts.fill ? p.maxPerDay : p.minPerDay + Math.floor(rng() * (p.maxPerDay - p.minPerDay + 1)));
    const room = Math.floor(target * share) - (opts.used?.get(key) ?? 0);
    const n = Math.min(room, count - out.length);
    if (n <= 0) continue;
    const part = w.end.diff(start).toMillis() / n;
    for (let i = 0; i < n; i++) {
      // the middle 80% of each part, so neighbours keep a distance
      out.push(new Date(start.toMillis() + Math.floor(part * (i + 0.1 + 0.8 * rng()))));
    }
  }
  return out;
}
