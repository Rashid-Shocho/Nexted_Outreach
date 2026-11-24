import dns from 'node:dns/promises';
import https from 'node:https';
import tls from 'node:tls';

/**
 * fetch for Google's APIs on lines that lose the way to some of Google's addresses.
 *
 * Google answers for all its APIs at many addresses. When one does not answer, the next is tried.
 * Every connection is checked against the real host name's certificate, so only Google can answer.
 * Nothing is sent before a connection stands; that is why moving to another address is always safe.
 */

const OTHER_DOORS = ['oauth2.googleapis.com', 'accounts.google.com', 'www.google.com'];
const CONNECT_MS = 3000;
const MAX_BYTES = 40 * 1024 * 1024;

const lastGood = new Map<string, string>();

const lookup = async (host: string): Promise<string[]> => {
  try {
    return (await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address);
  } catch {
    return [];
  }
};

/** The address that worked last, then the host's own and the other doors in turn. */
export async function addressesFor(host: string): Promise<string[]> {
  const [own, ...others] = await Promise.all([lookup(host), ...OTHER_DOORS.map(lookup)]);
  const doors = others.map((o) => o[0]).filter(Boolean);
  const out: string[] = [];
  const good = lastGood.get(host);
  if (good) out.push(good);
  for (let i = 0; i < 4; i++) {
    if (own[i]) out.push(own[i]);
    if (doors[i]) out.push(doors[i]);
  }
  return [...new Set(out)].slice(0, 8);
}

function open(ip: string, host: string, port: number, ca?: string): Promise<tls.TLSSocket> {
  return new Promise((ok, fail) => {
    const s = tls.connect({ host: ip, port, servername: host, ALPNProtocols: ['http/1.1'], ca });
    const timer = setTimeout(() => s.destroy(new Error('connect timeout')), CONNECT_MS);
    s.once('secureConnect', () => {
      clearTimeout(timer);
      s.removeAllListeners('error');
      ok(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      s.destroy();
      fail(e);
    });
  });
}

interface Hooks {
  addresses?: (host: string) => Promise<string[]>;
  port?: number;
  ca?: string;
}

export async function googleFetch(url: string, init: RequestInit = {}, timeoutMs = 30_000, hooks: Hooks = {}): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/(^|\.)googleapis\.com$/.test(u.hostname)) throw new Error('Only for Google’s APIs.');
  let socket: tls.TLSSocket | undefined;
  let why = 'no address';
  for (const ip of await (hooks.addresses ?? addressesFor)(u.hostname)) {
    try {
      socket = await open(ip, u.hostname, hooks.port ?? 443, hooks.ca);
      lastGood.set(u.hostname, ip);
      break;
    } catch (e: any) {
      why = e?.code ?? e?.message ?? String(e);
      if (lastGood.get(u.hostname) === ip) lastGood.delete(u.hostname);
    }
  }
  if (!socket) throw Object.assign(new Error(`no connection to ${u.hostname} (${why})`), { code: 'UND_ERR_CONNECT_TIMEOUT' });

  const sock = socket;
  const body = init.body === undefined || init.body === null ? null : Buffer.from(String(init.body));
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (body && !headers['content-type'] && init.body instanceof URLSearchParams) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  // this very connection and no other: an agent that can only hand out `sock`, once
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  let handed = false;
  (agent as any).createConnection = () => {
    if (handed) throw new Error('one request per connection');
    handed = true;
    return sock;
  };
  return new Promise<Response>((ok, fail) => {
    const req = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: init.method ?? 'GET', headers: { ...headers, connection: 'close', ...(body ? { 'content-length': body.length } : {}) }, agent },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy(new Error('answer too large'));
          else parts.push(c);
        });
        res.on('error', done(fail));
        res.on('end', () => {
          clearTimeout(timer);
          if (!res.complete) return fail(Object.assign(new Error('answer cut off'), { code: 'ECONNRESET' }));
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
          const status = res.statusCode ?? 500;
          ok(new Response([204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(parts)), { status, headers: h }));
        });
      },
    );
    // from here on the request may have arrived: the error must not look like "never connected"
    const done = (f: (e: Error) => void) => (e: any) => {
      clearTimeout(timer);
      f(Object.assign(new Error(e?.message ?? 'connection lost'), { code: 'CONNECTION_LOST' }));
    };
    const timer = setTimeout(() => req.destroy(new Error('no answer in time')), timeoutMs);
    req.on('error', done(fail));
    if (body) req.write(body);
    req.end();
  });
}
