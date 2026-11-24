import { db } from '../db';
import { ownTestAddress } from '../env';
import { mail } from '../mail';

/**
 * Gmail sends an account without history to Spam when it writes to strangers. LIVE sending needs an
 * account in normal use; our own test addresses may always be written to.
 */
export const OLD_ENOUGH = 20;
const AGAIN_MS = 60 * 60_000;

export const tooNewText = (n: number) => `This Gmail is too new for real sending: it has ${n === 0 ? 'no messages' : n === 1 ? 'only 1 message' : `only ${n} messages`} older than 30 days (at least ${OLD_ENOUGH} are needed). Its emails would go to Spam. Use the student’s everyday Gmail, or use this one normally for some weeks. Own test addresses (EMAIL_SANDBOX_ALLOW) can still be written to.`;

/** Asks Gmail. An account that was old enough once stays so. `fresh` asks again even when asked a moment ago. */
export async function oldMessages(studentId: string, fresh = false): Promise<number> {
  const mb = await db.mailbox.findUniqueOrThrow({ where: { studentId }, select: { oldMessages: true, ageCheckedAt: true } });
  if (mb.oldMessages !== null && (mb.oldMessages >= OLD_ENOUGH || (!fresh && mb.ageCheckedAt && Date.now() - mb.ageCheckedAt.getTime() < AGAIN_MS))) return mb.oldMessages;
  const n = await mail().oldMessages(studentId, OLD_ENOUGH);
  await db.mailbox.update({ where: { studentId }, data: { oldMessages: n, ageCheckedAt: new Date() } });
  return n;
}

/** Why real emails to these addresses may not be sent from this account, or null. */
export async function tooNewFor(studentId: string, to: string[], fresh = false): Promise<string | null> {
  if (to.every(ownTestAddress)) return null;
  const n = await oldMessages(studentId, fresh);
  return n >= OLD_ENOUGH ? null : tooNewText(n);
}
