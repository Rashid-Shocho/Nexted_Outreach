import { env, sandboxAllow, testMode } from '../env';
import { fakeProvider } from './fake';
import { gmailProvider } from './gmail';
import { resolveRecipient } from './mime';
import type { MailProvider, OutMessage } from './types';

export * from './types';

export const sandboxCfg = (live: boolean) => ({ sandbox: testMode(live), sandboxTo: env().EMAIL_SANDBOX_TO, allow: sandboxAllow() });
export const recipientFor = (to: string, subject: string, live: boolean) => resolveRecipient(to, subject, sandboxCfg(live));

/** Last line of defence: in test mode no draft may be addressed to anybody else. */
function guard(m: OutMessage) {
  const c = sandboxCfg(m.live === true);
  const to = m.to.trim().toLowerCase();
  if (c.sandbox && to !== (c.sandboxTo ?? '').trim().toLowerCase() && !c.allow.includes(to)) {
    throw new Error('Sandbox is on: refusing to address this email to anyone but the test inbox.');
  }
}

export function mail(): MailProvider {
  const p = env().EMAIL_TRANSPORT === 'gmail' ? gmailProvider : fakeProvider;
  return {
    ...p,
    createDraft: (s, m) => (guard(m), p.createDraft(s, m)),
    updateDraft: (s, d, m) => (guard(m), p.updateDraft(s, d, m)),
  };
}
