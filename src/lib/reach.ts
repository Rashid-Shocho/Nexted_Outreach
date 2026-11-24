/**
 * fetch that survives a bad line. Some networks lose the way to a server for a minute.
 *
 * A request whose connection was never made did not reach the other side, so it may always be repeated,
 * even "send". Anything that broke later is repeated only for reading (GET).
 */

const NEVER_CONNECTED = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

const codes = (e: any): string[] => [e?.code, e?.cause?.code, ...(e?.cause?.errors ?? []).map((x: any) => x?.code)].filter((c): c is string => typeof c === 'string');

/** True when the request cannot have arrived. */
export function neverConnected(e: unknown): boolean {
  const c = codes(e);
  return c.length > 0 && c.every((x) => NEVER_CONNECTED.has(x) || x === 'ETIMEDOUT') && c.some((x) => NEVER_CONNECTED.has(x));
}

export interface ReachOptions {
  timeoutMs?: number;
  /** Pauses between the tries */
  waits?: number[];
  /** How to make the request, instead of fetch */
  via?: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
}

export async function reach(url: string, init: RequestInit = {}, opts: ReachOptions = {}): Promise<Response> {
  const waits = opts.waits ?? [1000, 3000, 6000];
  const reading = (init.method ?? 'GET').toUpperCase() === 'GET';
  for (let i = 0; ; i++) {
    try {
      const ms = opts.timeoutMs ?? 30_000;
      return await (opts.via ? opts.via(url, init, ms) : fetch(url, { ...init, signal: AbortSignal.timeout(ms) }));
    } catch (e) {
      if (i >= waits.length || !(neverConnected(e) || reading)) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

export const netReason = (e: any): string => codes(e)[0] ?? String(e?.message ?? e);
