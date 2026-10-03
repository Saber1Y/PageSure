import { NextResponse } from 'next/server'
import { runPaidRequest } from '@/lib/agent/runner'
import { serviceRollups } from '@/lib/metering/aggregates'
import { USDC_SAC_TESTNET } from '@stellar/mpp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Playground endpoint. Runs a real MPP client against the gateway using the funded demo
 * payer, and returns the waterfall exactly as the SDK reported it.
 *
 * Public on purpose: an agent has no session and authenticates by paying.
 */
interface Body {
  slug?: string
  search?: Record<string, string>
  payload?: Record<string, string>
}

export async function POST(request: Request): Promise<Response> {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ detail: 'expected a JSON body' }, { status: 400 })
  }

  const slug = body.slug?.trim() ?? ''
  if (!slug) return NextResponse.json({ detail: 'slug is required' }, { status: 400 })

  const service = serviceRollups().find((s) => s.slug === slug)
  if (!service) {
    return NextResponse.json({ detail: `no service registered at /v1/${slug}` }, { status: 404 })
  }

  const result = await runPaidRequest({
    slug,
    search: body.search ?? {},
    body: body.payload,
  })

  return NextResponse.json({
    ...result,
    service: {
      slug: service.slug,
      name: service.name,
      mode: service.mode,
      priceBase: service.priceBase,
      asset: USDC_SAC_TESTNET,
    },
  })
}

/** Metadata for the Playground UI. */
export async function GET(): Promise<Response> {
  const services = serviceRollups().map((s) => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    mode: s.mode,
    priceBase: s.priceBase,
    assetCode: s.assetCode,
    decimals: s.decimals,
  }))
  return NextResponse.json({ services, asset: USDC_SAC_TESTNET })
}