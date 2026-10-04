/**
 * The upstream adapters this build can actually run.
 *
 * `services.upstreamKind` is a plain TEXT column with no enum constraint, and `runUpstream`
 * dispatches on it with a `default:` branch that throws. That throw happens *after* the payment
 * has settled in charge mode, so an unrecognised kind is not a validation error at request time -
 * it is money taken for a 500.
 *
 * Which makes this list load-bearing at creation time. A service must not be publishable with a
 * kind no adapter handles, so the creation form and the server action both validate against
 * exactly this array.
 *
 * The env column is what an operator needs to know before publishing, not after: `search` and
 * `summarize` are dead until configured, and `PAGESURE_UPSTREAM_MODE` defaults to strict, so an
 * unconfigured provider fails loudly rather than serving something fake.
 */
export const UPSTREAM_KINDS = ['search', 'market', 'summarize'] as const

export type UpstreamKind = (typeof UPSTREAM_KINDS)[number]

export interface UpstreamDescriptor {
  kind: UpstreamKind
  label: string
  /** What the client sends, shown on the creation form so the endpoint is predictable. */
  clientHint: string
  /** Environment that must be set, or the endpoint answers 503 after payment. */
  requires: string
  /** True when it works with no configuration at all. */
  keyless: boolean
}

export const UPSTREAMS: readonly UpstreamDescriptor[] = [
  {
    kind: 'search',
    label: 'Web search',
    clientHint: 'GET ?q=<query>',
    requires: 'BRAVE_API_KEY, TAVILY_API_KEY or EXA_API_KEY',
    keyless: false,
  },
  {
    kind: 'market',
    label: 'Market data',
    clientHint: 'GET ?ids=<coin ids>',
    requires: 'nothing - CoinGecko is keyless',
    keyless: true,
  },
  {
    kind: 'summarize',
    label: 'Summariser',
    clientHint: 'GET ?text=<text>',
    requires: 'LLM_BASE_URL',
    keyless: false,
  },
]
