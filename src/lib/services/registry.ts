import { db } from '@/lib/db/client'
import { services } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

/** Result of looking up a service from its URL slug. */
export interface ResolvedService {
  id: string
  slug: string
  name: string
  description: string
  assetCode: string
  assetContract: string
  decimals: number
  priceBase: string
  mode: 'charge' | 'channel'
  upstreamKind: string
  upstreamConfig: Record<string, unknown>
  policyId: string | null
  status: 'live' | 'paused' | 'draft'
}

export function resolveServiceBySlug(slug: string): ResolvedService | null {
  const row = db().select().from(services).where(eq(services.slug, slug)).get()
  return row ? normalise(row) : null
}

export function resolveServiceById(id: string): ResolvedService | null {
  const row = db().select().from(services).where(eq(services.id, id)).get()
  return row ? normalise(row) : null
}

type RawService = typeof services.$inferSelect

function normalise(row: RawService): ResolvedService {
  // upstreamConfig is a Drizzle `mode: 'json'` column, so it arrives already parsed.
  const parsed: unknown = row.upstreamConfig
  const config: Record<string, unknown> =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  const mode = row.mode === 'channel' ? 'channel' : 'charge'
  const status = row.status === 'live' || row.status === 'paused' ? row.status : 'draft'
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    assetCode: row.assetCode,
    assetContract: row.assetContract,
    decimals: row.decimals,
    priceBase: row.priceBase,
    mode,
    upstreamKind: row.upstreamKind,
    upstreamConfig: config,
    policyId: row.policyId,
    status,
  }
}

/** Service URLs are /v1/:slug/* ; the remainder is forwarded to the upstream. */
export function buildServicePath(slug: string, search: string): string {
  return `/v1/${slug}${search}`
}