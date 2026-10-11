/**
 * Upstream adapters.
 *
 * STRICT BY DEFAULT. In `strict` mode an unconfigured provider fails loudly with a
 * 503 naming the missing environment variable, because a judge must never be able to
 * mistake a local fallback for a real third-party API. Local fallbacks exist for
 * development only and require PAGESURE_ALLOW_LOCAL_UPSTREAM=1.
 *
 * Every adapter reports its provider NAME, which is recorded on the request row and
 * shown in the dashboard, so it is always visible which real API served a call.
 */

import { upstreamRunnerOverride } from '@/lib/testing/overrides'
export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchResponse {
  provider: string
  results: SearchResult[]
}

export interface MarketQuote {
  symbol: string
  price: number
  change24h: number | null
  venue: string
  asOf: string
}

export interface MarketResponse {
  provider: string
  quotes: MarketQuote[]
}

export interface SummaryResponse {
  provider: string
  model: string
  summary: string
}

export interface UpstreamContext {
  serviceId: string
  serviceName: string
  /** Which adapter to run: 'search' | 'market' | 'summarize'. */
  upstreamKind: string
  config: Record<string, unknown>
  /** Original client query string, so adapters can read their own params. */
  search: URLSearchParams
  /** POST body when the client sent one. */
  body: unknown
  /** Incoming request cancellation, combined with the configured upstream deadline. */
  signal?: AbortSignal
}

export class UpstreamError extends Error {
  readonly status: number
  readonly provider: string

  constructor(provider: string, message: string, status = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.provider = provider
    this.status = status
  }
}

/** True when the adapter found the credentials it needs. */
export type Availability = { ready: true } | { ready: false; reason: string }

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : undefined
}

export function strictMode(): boolean {
  return (process.env.PAGESURE_UPSTREAM_MODE ?? 'strict') === 'strict'
}

export function localFallbackEnabled(): boolean {
  return process.env.PAGESURE_ALLOW_LOCAL_UPSTREAM === '1'
}

function requireEnv(provider: string, ...names: string[]): string {
  for (const name of names) {
    const value = env(name)
    if (value) return value
  }
  throw new UpstreamError(
    provider,
    `${provider} is not configured. Set ${names.join(' or ')} in .env. ` +
      `PageSure runs in strict mode and will not silently substitute a local fallback.`,
    503,
  )
}

async function readJson(response: Response, provider: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamError(provider, `${provider} returned ${response.status}: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UpstreamError(provider, `${provider} returned a non-JSON body`)
  }
}

// ---------------------------------------------------------------------------
// search: Brave -> Tavily -> Exa
// ---------------------------------------------------------------------------

const searchProviders = {
  async brave(ctx: UpstreamContext): Promise<SearchResponse> {
    const provider = 'Brave Search API'
    const key = requireEnv(provider, 'BRAVE_API_KEY')
    const q = ctx.search.get('q') ?? ctx.search.get('query') ?? ''
    if (!q) throw new UpstreamError(provider, 'missing required query parameter "q"', 400)

    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', q)
    url.searchParams.set('count', String(ctx.search.get('count') ?? '5'))

    const payload = (await readJson(
      await fetch(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: ctx.signal }),
      provider,
    )) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }

    return {
      provider,
      results: (payload.web?.results ?? []).slice(0, 10).map((r) => ({
        title: r.title ?? '(untitled)',
        url: r.url ?? '',
        snippet: r.description ?? '',
      })),
    }
  },

  async tavily(ctx: UpstreamContext): Promise<SearchResponse> {
    const provider = 'Tavily'
    const key = requireEnv(provider, 'TAVILY_API_KEY')
    const q = ctx.search.get('q') ?? ctx.search.get('query') ?? ''
    if (!q) throw new UpstreamError(provider, 'missing required query parameter "q"', 400)

    const payload = (await readJson(
      await fetch('https://api.tavily.com/search', {
        method: 'POST',
        signal: ctx.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query: q,
          max_results: Number(ctx.search.get('count') ?? '5'),
          search_depth: 'basic',
        }),
      }),
      provider,
    )) as { results?: Array<{ title?: string; url?: string; content?: string }> }

    return {
      provider,
      results: (payload.results ?? []).slice(0, 10).map((r) => ({
        title: r.title ?? '(untitled)',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 400),
      })),
    }
  },

  async exa(ctx: UpstreamContext): Promise<SearchResponse> {
    const provider = 'Exa'
    const key = requireEnv(provider, 'EXA_API_KEY')
    const q = ctx.search.get('q') ?? ctx.search.get('query') ?? ''
    if (!q) throw new UpstreamError(provider, 'missing required query parameter "q"', 400)

    const payload = (await readJson(
      await fetch('https://api.exa.ai/search', {
        method: 'POST',
        signal: ctx.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ query: q, numResults: Number(ctx.search.get('count') ?? '5') }),
      }),
      provider,
    )) as { results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }> }

    return {
      provider,
      results: (payload.results ?? []).slice(0, 10).map((r) => ({
        title: r.title ?? '(untitled)',
        url: r.url ?? '',
        snippet: (r.snippet ?? r.text ?? '').slice(0, 400),
      })),
    }
  },
}

const SEARCH_ORDER = ['brave', 'tavily', 'exa'] as const

export async function runSearch(ctx: UpstreamContext): Promise<SearchResponse> {
  const failures: string[] = []
  for (const name of SEARCH_ORDER) {
    try {
      return await searchProviders[name](ctx)
    } catch (error) {
      if (ctx.signal?.aborted) {
        throw new UpstreamError('search', 'Upstream request timed out or was cancelled', 504)
      }
      // A 4xx/5xx from a configured provider is a real outage for that provider;
      // trying the next is correct. A missing key is not an outage, it is a config
      // error, and we keep it visible in the aggregated message.
      failures.push(`${name}: ${(error as Error).message}`)
    }
  }
  throw new UpstreamError(
    'search',
    `no search provider available. ${failures.join(' | ')}`,
    503,
  )
}

// ---------------------------------------------------------------------------
// market: CoinGecko
//
// NOTE: a Stellar Horizon DEX order book is deliberately NOT used here.
//
// Horizon's /order_book endpoint only handles classic assets (native +
// credit_alphanum). It rejects a Soroban contract asset outright:
//   selling_asset_type=contract -> 400 invalid_order_book
// PageSure prices in USDC SAC, which IS a Soroban contract
// (CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA), so a Horizon order
// book cannot price the very asset this gateway charges in. An earlier version of this
// adapter tried it and silently returned zero quotes, which is worse than not
// offering it at all.
//
// CoinGecko's public endpoint is keyless and returns real prices.
// ---------------------------------------------------------------------------

const marketProviders = {
  async coingecko(ctx: UpstreamContext): Promise<MarketResponse> {
    const provider = 'CoinGecko'
    const key = env('COINGECKO_API_KEY')
    const ids = ctx.search.get('ids') ?? String(ctx.config.coinGeckoIds ?? 'stellar')
    const vs = String(ctx.config.vsCurrency ?? 'usd')

    const url = new URL('https://api.coingecko.com/api/v3/simple/price')
    url.searchParams.set('ids', ids)
    url.searchParams.set('vs_currencies', vs)
    url.searchParams.set('include_24hr_change', 'true')

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (key) headers['x-cg-demo-api-key'] = key

    const payload = (await readJson(await fetch(url, { headers, signal: ctx.signal }), provider)) as Record<
      string,
      Record<string, number>
    >

    const quotes: MarketQuote[] = Object.entries(payload).map(([id, entry]) => ({
      symbol: id.toUpperCase(),
      price: entry[vs] ?? 0,
      change24h: entry[`${vs}_24h_change`] ?? null,
      venue: 'CoinGecko',
      asOf: new Date().toISOString(),
    }))

    // An empty result means the requested coin id does not exist. Say so, rather than
    // returning an empty list that reads like a successful quote fetch.
    if (quotes.length === 0) {
      throw new UpstreamError(
        provider,
        `CoinGecko returned no data for ids="${ids}". Check the id, e.g. ids=stellar,ids=bitcoin.`,
        502,
      )
    }

    return { provider, quotes }
  },
}

export async function runMarket(ctx: UpstreamContext): Promise<MarketResponse> {
  try {
    return await marketProviders.coingecko(ctx)
  } catch (error) {
    if (ctx.signal?.aborted) throw new UpstreamError('market', 'Upstream request timed out or was cancelled', 504)
    throw new UpstreamError('market', (error as Error).message, 503)
  }
}

// ---------------------------------------------------------------------------
// summarize: any OpenAI-compatible chat completions endpoint
// ---------------------------------------------------------------------------

export async function runSummary(ctx: UpstreamContext): Promise<SummaryResponse> {
  const provider = 'LLM (OpenAI-compatible)'
  const base = requireEnv(provider, 'LLM_BASE_URL')
  const key = env('LLM_API_KEY')
  const model = env('LLM_MODEL') ?? 'gpt-4o-mini'

  const body = ctx.body as { text?: string; input?: string } | undefined
  const text = body?.text ?? body?.input ?? ctx.search.get('text') ?? ctx.search.get('q') ?? ''
  if (!text) throw new UpstreamError(provider, 'missing "text" in request body', 400)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`

  let payload: { choices?: Array<{ message?: { content?: string } }> }
  try {
    payload = (await readJson(
      await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctx.signal,
        headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'Summarise the supplied text accurately and concisely. No preamble.',
            },
            { role: 'user', content: text },
          ],
        }),
      }),
      provider,
    )) as { choices?: Array<{ message?: { content?: string } }> }
  } catch (error) {
    if (ctx.signal?.aborted) throw new UpstreamError(provider, 'Upstream request timed out or was cancelled', 504)
    throw error
  }

  return {
    provider,
    model,
    summary: payload.choices?.[0]?.message?.content?.trim() ?? '',
  }
}

export async function runUpstream(ctx: UpstreamContext): Promise<{
  provider: string
  status: number
  body: unknown
}> {
  const configuredTimeout = Number.parseInt(process.env.PAGESURE_UPSTREAM_TIMEOUT_MS ?? '15000', 10)
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(60_000, Math.max(100, configuredTimeout))
    : 15_000
  const deadline = AbortSignal.timeout(timeoutMs)
  const upstreamContext = {
    ...ctx,
    signal: ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline,
  }

  // Test-only substitution point. Unset in production, and settable only by scripts/prove-charge,
  // so the gateway's paid path can be proven without reaching a real provider. See
  // lib/testing/overrides.
  const override = upstreamRunnerOverride()
  if (override) return override(upstreamContext)

  switch (ctx.upstreamKind) {
    case 'search': {
      const result = await runSearch(upstreamContext)
      return { provider: result.provider, status: 200, body: result }
    }
    case 'market': {
      const result = await runMarket(upstreamContext)
      return { provider: result.provider, status: 200, body: result }
    }
    case 'summarize': {
      const result = await runSummary(upstreamContext)
      return { provider: result.provider, status: 200, body: result }
    }
    default:
      throw new UpstreamError(
        ctx.upstreamKind,
        `unknown upstream kind "${ctx.upstreamKind}"`,
        500,
      )
  }
}
