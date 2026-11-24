import { db } from '../db';
import { env } from '../env';
import { netReason, reach } from '../reach';

export interface LlmRequest {
  operation: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** How hard a reasoning model thinks (Groq) */
  effort?: 'low' | 'medium';
  /** A checking step: may use the provider's second model */
  check?: boolean;
  /** JSON schema of the answer (every field required) */
  schema?: Record<string, unknown>;
  /** What the mock provider answers */
  mock: () => unknown;
}

interface LlmReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    /** The provider's usage limit: wait this long; it is not the email's fault */
    public readonly waitMs?: number,
  ) {
    super(message);
  }
}

let blockedUntil = 0;
/** True while the AI provider has asked us to wait; nothing new is started meanwhile. */
export const aiWaiting = () => blockedUntil > Date.now();
export const clearAiWait = () => {
  blockedUntil = 0;
};

async function post(name: string, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await reach(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, { timeoutMs: 120_000 });
  } catch (e: any) {
    throw new LlmError(`${name} could not be reached (${netReason(e)}).`, true);
  }
  if (res.status === 429) {
    const sec = Number(res.headers.get('retry-after'));
    const waitMs = Math.min(6 * 3600_000, Math.max(5000, (Number.isFinite(sec) && sec > 0 ? sec : 60) * 1000));
    blockedUntil = Math.max(blockedUntil, Date.now() + waitMs);
    throw new LlmError(`${name}: usage limit reached, continuing later.`, true, waitMs);
  }
  if (res.status === 413) throw new LlmError(`${name}: this request is larger than your plan allows per minute. Shorten the text about the student.`, false);
  if (res.status === 401 || res.status === 403) throw new LlmError(`${name}: the API key was not accepted.`, false);
  if (!res.ok) throw new LlmError(`${name} ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status >= 500 || res.status === 400);
  return res.json();
}

async function gemini(r: LlmRequest): Promise<LlmReply> {
  const model = env().GEMINI_MODEL!;
  const d = await post('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': env().GEMINI_API_KEY! }, {
    systemInstruction: { parts: [{ text: r.system }] },
    contents: [{ role: 'user', parts: [{ text: r.prompt }] }],
    generationConfig: { temperature: r.temperature ?? 0.5, maxOutputTokens: r.maxOutputTokens ?? 4000, responseMimeType: 'application/json' },
  });
  const text = ((d?.candidates?.[0]?.content?.parts ?? []) as any[]).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  if (!text) throw new LlmError(`Gemini gave no text (${d?.candidates?.[0]?.finishReason ?? d?.promptFeedback?.blockReason ?? 'unknown'})`, true);
  const u = d.usageMetadata ?? {};
  return { text, model: d.modelVersion ?? model, inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

async function openai(r: LlmRequest): Promise<LlmReply> {
  const model = env().OPENAI_MODEL!;
  const d = await post('OpenAI', 'https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${env().OPENAI_API_KEY}` }, {
    model,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.prompt },
    ],
    max_completion_tokens: r.maxOutputTokens ?? 4000,
    response_format: { type: 'json_object' },
  });
  const text = d?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LlmError('OpenAI gave no text', true);
  return { text, model: d.model ?? model, inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 };
}

/** Groq counts the answer's maximum towards its tokens per minute, so it is kept small. */
async function groq(r: LlmRequest): Promise<LlmReply> {
  const model = r.check ? env().GROQ_CHECK_MODEL : env().GROQ_MODEL;
  const d = await post('Groq', 'https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${env().GROQ_API_KEY}` }, {
    model,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.prompt },
    ],
    temperature: r.temperature ?? 0.6,
    max_completion_tokens: r.maxOutputTokens ?? 2000,
    reasoning_effort: r.effort ?? 'low',
    include_reasoning: false,
    response_format: r.schema ? { type: 'json_schema', json_schema: { name: r.operation, strict: true, schema: r.schema } } : { type: 'json_object' },
  });
  const text = d?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LlmError(`Groq gave no text (${d?.choices?.[0]?.finish_reason ?? 'unknown'})`, true);
  return { text, model: d.model ?? model, inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 };
}

/** A strict schema: strings, lists of strings, or a choice of fixed words. */
export function objectSchema(fields: Record<string, 'string' | 'list' | string[]>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(fields),
    properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === 'list' ? { type: 'array', items: { type: 'string' } } : Array.isArray(v) ? { type: 'string', enum: v } : { type: 'string' }])),
  };
}

export function parseJson(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* falls through */
      }
    }
    throw new LlmError('The AI did not answer in the expected form.', true);
  }
}

/** Real students' details must not reach a free AI tier that may train on them. */
export function assertMayProcess(s: { isDemo: boolean; consentAt: Date | null }) {
  if (s.isDemo) return;
  if (!s.consentAt) throw new LlmError('This student has no recorded consent.', false);
  if (env().LLM_PROVIDER === 'gemini' && !env().GEMINI_PAID_TIER) {
    throw new LlmError('Real students need a paid AI plan. Set GEMINI_PAID_TIER=true once the key is on one, or use OpenAI.', false);
  }
}

let nextAt = 0;
async function pace() {
  const gap = 60_000 / env().LLM_RATE_PER_MIN;
  const at = Math.max(Date.now(), nextAt);
  nextAt = at + gap;
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

export async function llmJson(r: LlmRequest): Promise<unknown> {
  const provider = env().LLM_PROVIDER;
  if (provider === 'mock') return r.mock();
  for (let i = 0; ; i++) {
    try {
      return await once(r, provider);
    } catch (e) {
      // a per-minute limit: wait here, so work already done for this email is not thrown away
      const wait = e instanceof LlmError ? e.waitMs : undefined;
      if (wait === undefined || wait > SHORT_WAIT_MS || i >= 4) throw e;
      await new Promise((ok) => setTimeout(ok, wait + 500));
    }
  }
}

let SHORT_WAIT_MS = 75_000;
/** Tests do not wait. */
export const setShortWait = (ms: number) => {
  SHORT_WAIT_MS = ms;
};

async function once(r: LlmRequest, provider: 'groq' | 'gemini' | 'openai'): Promise<unknown> {
  await pace();
  try {
    const res = await (provider === 'groq' ? groq(r) : provider === 'gemini' ? gemini(r) : openai(r));
    await db.apiUsage.create({ data: { provider, model: res.model, operation: r.operation, inputTokens: res.inputTokens, outputTokens: res.outputTokens } });
    return parseJson(res.text);
  } catch (e) {
    await db.apiUsage.create({ data: { provider, model: '-', operation: r.operation, success: false } }).catch(() => undefined);
    throw e;
  }
}
