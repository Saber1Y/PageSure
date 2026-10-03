import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { paymentSessions } from '@/lib/db/schema'

/**
 * Session lookup helpers. The funder is the authoritative payer in channel mode
 * because it is baked into the deployed channel contract and read back from chain,
 * never taken from a request header.
 */

export function findSessionByChannel(channelContract: string) {
  return db()
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.channelContract, channelContract))
    .get()
}

export function findActiveSessionForFunder(funder: string, serviceId: string) {
  return db()
    .select()
    .from(paymentSessions)
    .where(
      and(
        eq(paymentSessions.funder, funder),
        eq(paymentSessions.serviceId, serviceId),
        inArray(paymentSessions.status, ['opening', 'active']),
      ),
    )
    .orderBy(sql`${paymentSessions.createdAt} desc`)
    .get()
}

export function listSessionsForService(serviceId: string, limit = 50) {
  return db()
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.serviceId, serviceId))
    .orderBy(sql`${paymentSessions.createdAt} desc`)
    .limit(limit)
    .all()
}

export function listAllSessions(limit = 100) {
  return db()
    .select()
    .from(paymentSessions)
    .orderBy(sql`${paymentSessions.createdAt} desc`)
    .limit(limit)
    .all()
}

export function getSession(id: string) {
  return db().select().from(paymentSessions).where(eq(paymentSessions.id, id)).get()
}

export function nextSessionRef(): string {
  const row = db()
    .select({ n: sql<number>`coalesce(max(cast(substr(${paymentSessions.ref}, 3) as integer)), 0)` })
    .from(paymentSessions)
    .get()
  return String((row?.n ?? 0) + 1)
}