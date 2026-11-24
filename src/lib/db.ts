import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';

const g = globalThis as unknown as { __prisma?: PrismaClient };

export const db = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') g.__prisma = db;

export async function audit(actor: string, action: string, entity: string, entityId?: string | null, data?: Prisma.InputJsonValue) {
  await db.auditLog.create({ data: { actor, action, entity, entityId: entityId ?? null, data } });
}

/** What staff stopped on the Control page. Sending includes putting drafts into Gmail. */
export async function stops() {
  const rows = await db.setting.findMany({ where: { key: { in: ['outreachPaused', 'writingPaused', 'inboxPaused'] } } });
  const on = (k: string) => rows.some((r) => r.key === k && r.value === true);
  return { sending: on('outreachPaused'), writing: on('writingPaused'), inbox: on('inboxPaused') };
}

export const outreachPaused = async (): Promise<boolean> => (await stops()).sending;
