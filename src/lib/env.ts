import 'dotenv/config';
import { z } from 'zod';

const flag = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const s = (v ?? '').trim().toLowerCase();
      return s === '' ? def : s === 'true' || s === '1' || s === 'yes';
    });
const opt = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim() || undefined);

const schema = z.object({
  APP_ENV: z.enum(['development', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:3400'),
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: opt,
  EMAIL_TRANSPORT: z.enum(['fake', 'gmail']).default('fake'),
  GMAIL_OAUTH_CLIENT_ID: opt,
  GMAIL_OAUTH_CLIENT_SECRET: opt,
  EMAIL_SANDBOX: flag(true), // a missing value never turns the sandbox off
  EMAIL_SANDBOX_TO: opt,
  /** Allows EMAIL_SANDBOX=false on this computer. Campaigns still have to be marked LIVE one by one. */
  EMAIL_REAL_LOCAL: flag(false),
  /** Own test addresses, separated by commas: in test mode these really get their email. At most ten. */
  EMAIL_SANDBOX_ALLOW: opt,
  INBOX_SCOPE: z.enum(['all', 'professors']).default('all'),
  RESEARCH: z.enum(['crossref', 'off']).default('crossref'),
  SYNC_SECONDS: z.coerce.number().int().min(5).default(120),
  LLM_PROVIDER: z.enum(['mock', 'groq', 'gemini', 'openai']).default('mock'),
  GROQ_API_KEY: opt,
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  /** Checks the claims; Groq counts each model's limit separately, so this does not slow the writer */
  GROQ_CHECK_MODEL: z.string().default('openai/gpt-oss-20b'),
  GEMINI_API_KEY: opt,
  GEMINI_MODEL: opt,
  GEMINI_PAID_TIER: flag(false),
  OPENAI_API_KEY: opt,
  OPENAI_MODEL: opt,
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  LLM_RATE_PER_MIN: z.coerce.number().int().min(1).default(60),
});

export type Env = z.infer<typeof schema>;

/** Problems that must stop the app from starting. Pure, so it can be tested. */
export function safetyProblems(e: Env): string[] {
  const out: string[] = [];
  if (e.APP_ENV !== 'production' && !e.EMAIL_SANDBOX && !e.EMAIL_REAL_LOCAL) {
    out.push('EMAIL_SANDBOX=false needs APP_ENV=production, or EMAIL_REAL_LOCAL=true to allow it on this computer.');
  }
  if (!e.EMAIL_SANDBOX_TO) out.push('EMAIL_SANDBOX_TO is needed: campaigns that are not LIVE send there.');
  if (e.APP_ENV === 'production') {
    if (e.EMAIL_TRANSPORT === 'fake') out.push('EMAIL_TRANSPORT=fake is not allowed in production.');
    if (e.LLM_PROVIDER === 'mock') out.push('LLM_PROVIDER=mock is not allowed in production.');
    if (!e.APP_URL.startsWith('https://')) out.push('APP_URL must be https in production.');
  }
  if (e.EMAIL_TRANSPORT === 'gmail') {
    if (!e.GMAIL_OAUTH_CLIENT_ID || !e.GMAIL_OAUTH_CLIENT_SECRET) out.push('Gmail needs GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET.');
  }
  if (!e.TOKEN_ENCRYPTION_KEY || Buffer.from(e.TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) {
    out.push('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 (npm run gen:key).');
  }
  if (e.LLM_PROVIDER === 'groq' && !e.GROQ_API_KEY) out.push('Groq needs GROQ_API_KEY.');
  if (e.LLM_PROVIDER === 'gemini' && (!e.GEMINI_API_KEY || !e.GEMINI_MODEL)) out.push('Gemini needs GEMINI_API_KEY and GEMINI_MODEL.');
  if (e.LLM_PROVIDER === 'openai' && (!e.OPENAI_API_KEY || !e.OPENAI_MODEL)) out.push('OpenAI needs OPENAI_API_KEY and OPENAI_MODEL.');
  return out;
}

export const parseEnv = (src: NodeJS.ProcessEnv): Env => schema.parse(src);

let checked: Env | undefined;

/** Reads and checks the settings on first use, so `next build` does not need them. */
export function env(): Env {
  if (!checked) {
    const e = parseEnv(process.env);
    const problems = safetyProblems(e);
    if (problems.length) throw new Error(`Refusing to start:\n- ${problems.join('\n- ')}`);
    checked = e;
  }
  return checked;
}

/** The own test addresses of EMAIL_SANDBOX_ALLOW. Whole addresses only: no domains, no wildcards. */
export function sandboxAllow(list: string | undefined = env().EMAIL_SANDBOX_ALLOW): string[] {
  return (list ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^[^\s@*]+@[^\s@*]+\.[a-z]{2,}$/.test(x))
    .slice(0, 10);
}

/** Is this one of our own test addresses? */
export const ownTestAddress = (to: string) => sandboxAllow().includes(to.trim().toLowerCase());

/** Test mode holds unless the master switch is off AND the campaign is marked LIVE. */
export const testMode = (live: boolean) => env().EMAIL_SANDBOX || !live;

/** Real Gmail with the example test inbox: nothing may be drafted or sent, it would only bounce. */
export const sandboxMissing = () => env().EMAIL_TRANSPORT === 'gmail' && /@example\.(test|com|org|net)$|^your/i.test(env().EMAIL_SANDBOX_TO ?? '');

export const gmailRedirectUri = () => `${env().APP_URL.replace(/\/$/, '')}/api/gmail/callback`;
