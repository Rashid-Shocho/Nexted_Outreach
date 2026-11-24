import 'server-only';
import { db } from './db';
import { env } from './env';
import { currentStamp, startStamp } from './stamp';
import { normaliseEmail, type Mapping } from './excel';

/** Which addresses of a list were already contacted, by this student or for others. */
export async function knownContacts(studentId: string, rows: string[][], map: Mapping) {
  const col = map.email;
  const emails = col === undefined ? [] : [...new Set(rows.map((r) => normaliseEmail(r[col] ?? '')).filter((e): e is string => !!e))];
  const found = await db.email.findMany({ where: { toEmail: { in: emails }, status: { not: 'CANCELLED' } }, select: { toEmail: true, studentId: true, student: { select: { fullName: true } } } });
  const sameStudent = new Set<string>();
  const otherStudents = new Map<string, string[]>();
  for (const f of found) {
    if (f.studentId === studentId) sameStudent.add(f.toEmail);
    else otherStudents.set(f.toEmail, [...new Set([...(otherStudents.get(f.toEmail) ?? []), f.student.fullName])]);
  }
  return { sameStudent, otherStudents };
}

/** Is the background worker running? It reports every 20 seconds. */
export async function workerState() {
  const rows = await db.setting.findMany({ where: { key: { in: ['heartbeat:email', 'heartbeat:ai'] } } });
  const alive = (k: string) => Date.now() - Number(rows.find((r) => r.key === k)?.value ?? 0) < 90_000;
  return { email: alive('heartbeat:email'), ai: alive('heartbeat:ai') };
}

/** Settings or code changed after the worker or the website was started (development only: a server is restarted by its updates). */
export async function restartNeeded(): Promise<{ worker: boolean; website: boolean }> {
  if (env().APP_ENV === 'production') return { worker: false, website: false };
  const now = currentStamp();
  const rows = await db.setting.findMany({ where: { key: { in: ['stamp:all', 'stamp:email', 'stamp:ai'] } } });
  const latest = rows.map((r) => r.value as unknown as { settings: string; code: string; at: number }).sort((a, b) => b.at - a.at)[0];
  return { worker: !latest || latest.settings !== now.settings || latest.code !== now.code, website: startStamp.settings !== now.settings };
}

export async function unreadCount() {
  return db.thread.count({ where: { hasIncoming: true, unread: true, kind: 'PROFESSOR' } });
}

export async function campaignCounts(ids: string[]) {
  const rows = await db.email.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } });
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) out.set(r.campaignId, { ...(out.get(r.campaignId) ?? {}), [r.status]: r._count._all });
  return out;
}
