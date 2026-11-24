import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { db } from './db';
import { env } from './env';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto';

const HOURS = 12;
const name = () => (env().APP_ENV === 'production' ? '__Host-outreach' : 'outreach');
let dummy: Promise<string> | undefined;

/** Returns an error text, or null when the staff member is signed in. */
export async function signIn(email: string, password: string): Promise<string | null> {
  const wrong = 'Wrong email or password.';
  const s = await db.staff.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!s || !s.active) {
    await verifyPassword(password, await (dummy ??= hashPassword('not a real password'))); // same time as a real check
    return wrong;
  }
  if (s.lockedUntil && s.lockedUntil > new Date()) return 'Too many wrong passwords. Try again in 15 minutes.';
  if (!(await verifyPassword(password, s.passwordHash))) {
    const u = await db.staff.update({ where: { id: s.id }, data: { failedLogins: { increment: 1 } } });
    if (u.failedLogins >= 8) await db.staff.update({ where: { id: s.id }, data: { failedLogins: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } });
    return wrong;
  }
  const token = randomToken();
  const expiresAt = new Date(Date.now() + HOURS * 3600_000);
  await db.$transaction([
    db.staff.update({ where: { id: s.id }, data: { failedLogins: 0, lockedUntil: null } }),
    db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    db.session.create({ data: { tokenHash: sha256(token), staffId: s.id, expiresAt } }),
  ]);
  (await cookies()).set(name(), token, { httpOnly: true, sameSite: 'lax', secure: env().APP_ENV === 'production', path: '/', expires: expiresAt });
  return null;
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(name())?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(name());
}

export const currentStaff = cache(async () => {
  const token = (await cookies()).get(name())?.value;
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { staff: true } });
  if (!s || s.expiresAt < new Date() || !s.staff.active) return null;
  return { id: s.staff.id, name: s.staff.name, email: s.staff.email };
});

/** Every page, action and API route starts with this. */
export async function requireStaff() {
  const s = await currentStaff();
  if (!s) redirect('/login');
  return s;
}
