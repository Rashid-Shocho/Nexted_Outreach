import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { googleFetch } from '../../src/lib/googleFetch';
import { reach } from '../../src/lib/reach';

// a stand-in for Google on this computer, with its own certificate
function certificate(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k'), '-out', path.join(dir, 'c'), '-days', '2', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return { key: fs.readFileSync(path.join(dir, 'k'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'c'), 'utf8') };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const good = certificate('gmail.googleapis.com');
const other = certificate('evil.example.test');
const skip = good && other ? false : 'openssl is not here';

async function server(c: { key: string; cert: string }, handler: (req: any, res: any) => void) {
  const s = https.createServer(c, handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: (s.address() as any).port as number,
    close: () => {
      s.closeAllConnections();
      s.close();
    },
  };
}

test('a dead address is skipped, the request arrives once, body and headers intact', { skip }, async () => {
  const seen: any[] = [];
  const s = await server(good!, (req, res) => {
    let b = '';
    req.on('data', (c: Buffer) => (b += c));
    req.on('end', () => {
      seen.push([req.method, req.url, req.headers.authorization, b]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: 'ü' }));
    });
  });
  const hooks = { port: s.port, ca: good!.cert, addresses: async () => ["192.0.2.1", "127.0.0.1"] };
  const r = await googleFetch('https://gmail.googleapis.com/a?b=1', { method: 'POST', headers: { Authorization: 'Bearer x' }, body: JSON.stringify({ t: 'ß' }) }, 5000, hooks);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: 'ü' });
  assert.deepEqual(seen, [['POST', '/a?b=1', 'Bearer x', '{"t":"ß"}']]);
  s.close();
});

test('a server without the right certificate is never used', { skip }, async () => {
  let hits = 0;
  const s = await server(other!, (_req, res) => {
    hits++;
    res.end('x');
  });
  await assert.rejects(googleFetch('https://gmail.googleapis.com/', {}, 3000, { port: s.port, ca: other!.cert, addresses: async () => ['127.0.0.1'] }), (e: any) => e.code === 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(hits, 0);
  s.close();
});

test('cut off after it was sent: not repeated for sending', { skip }, async () => {
  let hits = 0;
  const s = await server(good!, (req) => {
    hits++;
    req.socket.destroy();
  });
  const via = (u: string, i: RequestInit, ms: number) => googleFetch(u, i, ms, { port: s.port, ca: good!.cert, addresses: async () => ['127.0.0.1'] });
  await assert.rejects(reach('https://gmail.googleapis.com/send', { method: 'POST', body: '{}' }, { via, waits: [1, 1] }));
  assert.equal(hits, 1);
  await assert.rejects(reach('https://gmail.googleapis.com/read', {}, { via, waits: [1, 1] }));
  assert.equal(hits, 4, 'reading is repeated');
  s.close();
});

test('no answer in time is not repeated for sending', { skip }, async () => {
  let hits = 0;
  const s = await server(good!, () => {
    hits++;
  });
  const via = (u: string, i: RequestInit) => googleFetch(u, i, 300, { port: s.port, ca: good!.cert, addresses: async () => ['127.0.0.1'] });
  await assert.rejects(reach('https://gmail.googleapis.com/send', { method: 'POST', body: '{}' }, { via, waits: [1, 1] }));
  assert.equal(hits, 1);
  s.close();
});

test('only Google addresses, only https', async () => {
  await assert.rejects(googleFetch('https://example.com/'));
  await assert.rejects(googleFetch('http://gmail.googleapis.com/'));
  await assert.rejects(googleFetch('https://gmail.googleapis.com.evil.test/'));
});
