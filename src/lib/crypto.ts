import crypto from 'node:crypto';
import { env } from './env';

const key = () => Buffer.from(env().TOKEN_ENCRYPTION_KEY!, 'base64');

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64 parts). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognised encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) =>
    crypto.scrypt(password.normalize('NFKC'), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${(await scrypt(password, salt)).toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
