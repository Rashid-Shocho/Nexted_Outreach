import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A short mark of the settings file and of the code the worker runs. The worker keeps the mark it
 * started with; when the files change, the website can say that a restart is needed.
 */

function files(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])).sort();
  } catch {
    return [];
  }
}

const read = (f: string) => {
  try {
    return fs.readFileSync(f);
  } catch {
    return Buffer.alloc(0);
  }
};

export interface Stamp {
  settings: string;
  code: string;
}

export function stampOf(root = process.cwd()): Stamp {
  const mark = (parts: Buffer[]) => {
    const h = crypto.createHash('sha256');
    for (const p of parts) h.update(p).update('\n');
    return h.digest('hex').slice(0, 16);
  };
  return {
    settings: mark([read(path.join(root, '.env'))]),
    code: mark(['src/lib', 'src/worker'].flatMap((d) => files(path.join(root, d))).map(read)),
  };
}

let cached: { at: number; stamp: Stamp } | undefined;

/** The files as they are now, looked at no more than every five seconds. */
export function currentStamp(): Stamp {
  if (!cached || Date.now() - cached.at > 5000) cached = { at: Date.now(), stamp: stampOf() };
  return cached.stamp;
}

/** What this program was started with. */
export const startStamp: Stamp = stampOf();
