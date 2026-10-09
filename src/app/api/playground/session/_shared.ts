import { serviceRollups } from '@/lib/metering/aggregates'

export interface ChannelService {
  slug: string
  name: string
  priceBase: string
  decimals: number
  assetCode: string
}

/** Resolve a live channel-mode service owned by this organization, or null. */
export function channelService(organizationId: string, slug: string): ChannelService | null {
  if (!slug) return null
  const service = serviceRollups(organizationId).find((s) => s.slug === slug)
  if (!service || service.mode !== 'channel' || service.status !== 'live') return null
  return {
    slug: service.slug,
    name: service.name,
    priceBase: service.priceBase,
    decimals: service.decimals,
    assetCode: service.assetCode,
  }
}

/** Turn a thrown runner error (which may carry lifecycle steps) into a response body. */
export function errorBody(error: unknown): { ok: false; error: string; steps?: unknown } {
  const steps = (error as { steps?: unknown }).steps
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(Array.isArray(steps) ? { steps } : {}),
  }
}
