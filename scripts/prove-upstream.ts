/** Offline proof for upstream deadlines and per-request credential lookup. */
import { UpstreamError, runUpstream } from '../src/lib/upstream'

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ok   ${name}`) }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}

const savedFetch = globalThis.fetch
const envKeys = ['BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PAGESURE_UPSTREAM_TIMEOUT_MS']
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const context = {
  serviceId: 'svc-proof',
  serviceName: 'Upstream proof',
  upstreamKind: 'search',
  config: {},
  search: new URLSearchParams('q=deadline-proof'),
  body: null,
}

try {
  delete process.env.TAVILY_API_KEY
  delete process.env.EXA_API_KEY
  process.env.PAGESURE_UPSTREAM_TIMEOUT_MS = '1000'
  const observedKeys: string[] = []
  globalThis.fetch = async (_input, init) => {
    observedKeys.push(new Headers(init?.headers).get('x-subscription-token') ?? '')
    if (!(init?.signal instanceof AbortSignal)) throw new Error('upstream fetch received no deadline signal')
    return new Response(JSON.stringify({ web: { results: [{ title: 'ok', url: 'https://example.test', description: 'test' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  process.env.BRAVE_API_KEY = 'first-test-key'
  const first = await runUpstream(context)
  process.env.BRAVE_API_KEY = 'rotated-test-key'
  const second = await runUpstream(context)
  check('upstream receives a bounded cancellation signal', observedKeys.length === 2)
  check('credential rotation is picked up on the next request', observedKeys[0] === 'first-test-key' && observedKeys[1] === 'rotated-test-key')
  check('successful requests are served by the configured provider', first.provider === 'Brave Search API' && second.provider === 'Brave Search API')

  process.env.PAGESURE_UPSTREAM_TIMEOUT_MS = '20'
  let attempts = 0
  globalThis.fetch = async (_input, init) => {
    attempts++
    const signal = init?.signal
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    throw new Error('deadline signal was not aborted')
  }
  let timeout: unknown
  try { await runUpstream(context) } catch (error) { timeout = error }
  check('deadline returns an explicit 504 upstream error', timeout instanceof UpstreamError && timeout.status === 504)
  check('timed out request does not retry the same provider', attempts === 1, `attempted ${attempts} times`)
} finally {
  globalThis.fetch = savedFetch
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
