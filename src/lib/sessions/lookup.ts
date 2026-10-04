import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { paymentSessions } from '@/lib/db/schema'

/**
 * Session lookup helpers. The funder is the authoritative payer in channel mode
 * because it is baked into the deployed channel contract and read back from chain,
 * never taken from a request header.
 *
 * TENANT SCOPE: the three gateway-side helpers (`findSessionByChannel`,
 * `findActiveSessionForFunder`, `listSessionsForService`) resolve the organization from the
 * service, which is already established by the caller, so they key off serviceId. The
 * dashboard-side helpers (`listAllSessions`, `getSession`) take the caller's organizationId
 * from `requireUser()`.
 *
 * `getSession` is the one that matters most: it is a direct id lookup from a URL segment, so
 * without the organization filter any signed-in operator could read another tenant's session
 * by guessing or stealing its id. A foreign id returns the same thing a nonexistent one does.
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

export function listAllSessions(organizationId: string, limit = 100) {
  return db()
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.organizationId, organizationId))
    .orderBy(sql`${paymentSessions.createdAt} desc`)
    .limit(limit)
    .all()
}

export function getSession(organizationId: string, id: string) {
  return db()
    .select()
    .from(paymentSessions)
    .where(and(eq(paymentSessions.organizationId, organizationId), eq(paymentSessions.id, id)))
    .get()
}

/**
 * Session references are globally sequential so channel contract ids stay unique across all
 * organizations. This is an allocator, not a dashboard read: it must see every row, or two
 * tenants could be handed the same session ref.
 */
export function nextSessionRef(): string {
  const row = db()
    // substr(ref, 1) over the WHOLE value, not substr(ref, 3).
    //
    // The old `substr(ref, 3)` assumed a `ref_` prefix, but this function returns a bare
    // number and the column stores what it returns. On `'1'` that slice is the empty string,
    // which casts to 0, so max() stayed 0 and every single call after the first session
    // re-issued ref `1` and died on the unique index. The channel-mode happy path therefore
    // worked exactly once per database, which is why this had gone unnoticed: the first
    // attempt never hit the collision.
    .select({ n: sql<number>`coalesce(max(cast(${paymentSessions.ref} as integer)), 0)` })
    .from(paymentSessions)
    .get()
  return String((row?.n ?? 0) + 1)
}