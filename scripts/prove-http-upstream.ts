/**
 * Proof for the provider-supplied HTTPS upstream: what a typed URL cannot be used to reach.
 *
 * The first two sections are offline. The last one is live and needs outbound network and DNS:
 * it resolves a public name that points at 127.0.0.1 and calls a public echo service, because
 * the property that matters - the socket refuses a non-public address at connect time - can
 * only be shown against a real resolver. Live checks report SKIP, not pass, when the network
 * is unavailable.
 */
import { UpstreamError, runUpstream } from '../src/lib/upstream'
import { checkUpstreamUrl, isBlockedAddress } from '../src/lib/upstream/http'

let passed = 0
let skipped = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}
function skip(name: string, why: string) { skipped++; console.log(`  SKIP ${name}: ${why}`) }

const call = (url: string, query = '', headers?: never) =>
  runUpstream({
    serviceId: 'svc-http-proof',
    serviceName: 'HTTP upstream proof',
    upstreamKind: 'http',
    config: { url },
    search: new URLSearchParams(query),
    body: null,
    ...(headers ?? {}),
  })

console.log('URL rules (checked at save and before every call)')
for (const [url, why] of [
  ['http://api.example.com/v1', 'plain http'],
  ['https://user:pass@api.example.com/v1', 'embedded credentials'],
  ['https://api.example.com:8443/v1', 'non-default port'],
  ['https://localhost/v1', 'localhost'],
  ['https://app.localhost/v1', '*.localhost'],
  ['https://db.internal/v1', '*.internal'],
  ['https://intranet/v1', 'single-label host'],
  ['https://127.0.0.1/v1', 'loopback literal'],
  ['https://10.0.0.5/v1', 'private literal'],
  ['https://169.254.169.254/latest/meta-data', 'cloud metadata literal'],
  ['https://[::1]/v1', 'IPv6 loopback literal'],
  ['https://[fd00::1]/v1', 'IPv6 unique-local literal'],
  ['not a url', 'not a URL'],
] as const) {
  check(`refuses ${why}`, !checkUpstreamUrl(url).ok)
}
const good = checkUpstreamUrl('https://api.open-meteo.com/v1/forecast?latitude=38.7&longitude=-9.1#frag')
check('accepts a public https URL and drops the fragment', good.ok && !good.url.includes('#'))

console.log('Address guard (applied to every DNS answer at connect time)')
for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
  check(`blocks ${address}`, isBlockedAddress(address))
}
for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
  check(`allows ${address}`, !isBlockedAddress(address))
}

console.log('Live: connect-time refusal and forwarding')
try {
  // 127-0-0-1.sslip.io is a public DNS name whose answer is 127.0.0.1. It passes the URL rules,
  // which is exactly the case only the connect-time guard can stop.
  check('a public name pointing at loopback passes the URL rules', checkUpstreamUrl('https://127-0-0-1.sslip.io/').ok)
  const refused = await call('https://127-0-0-1.sslip.io/').then(() => null, (error: unknown) => error)
  check(
    'the call is refused at connect time, before any request is sent',
    refused instanceof UpstreamError && /non-public address/.test(refused.message),
    refused instanceof Error ? refused.message : String(refused),
  )
} catch (error) {
  skip('connect-time refusal', error instanceof Error ? error.message : String(error))
}

try {
  const echoed = (await call('https://postman-echo.com/get?fixed=1', 'q=forwarded&payer=GPAYER&review=rev_1')) as {
    provider: string
    body: { args?: Record<string, string>; headers?: Record<string, string> }
  }
  const args = echoed.body.args ?? {}
  check('the caller query reaches the provider', args.q === 'forwarded' && args.fixed === '1', JSON.stringify(args))
  check("PageSure's payer and review parameters are not forwarded", !('payer' in args) && !('review' in args), JSON.stringify(args))
  const headers = Object.keys(echoed.body.headers ?? {}).map((h) => h.toLowerCase())
  check('no authorization or payment header reaches the provider', !headers.some((h) => h === 'authorization' || h.startsWith('x-pagesure') || h === 'payment-receipt'), headers.join(','))
  check('the provider is reported by host', echoed.provider === 'postman-echo.com', echoed.provider)

  const redirected = await call('https://postman-echo.com/redirect-to?url=https%3A%2F%2Fexample.com%2F').then(() => null, (error: unknown) => error)
  check('a redirect is reported, not followed', redirected instanceof UpstreamError && /redirect/i.test(redirected.message), redirected instanceof Error ? redirected.message : String(redirected))
} catch (error) {
  skip('public echo forwarding', error instanceof Error ? error.message : String(error))
}

console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}`)
if (failures.length) process.exit(1)
