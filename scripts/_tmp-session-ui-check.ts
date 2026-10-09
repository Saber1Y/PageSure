import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { sessions, users } from '@/lib/db/schema'
import { createSession, sessionCookieName } from '@/lib/auth/session'

const origin = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const slug = process.env.E2E_SLUG ?? 'channel-demo'

const user = db().select().from(users).where(eq(users.organizationId, 'org_demo')).get()
if (!user) throw new Error('no demo user')
const { token } = createSession(user.id, 'tmp-playground-check')
const providedCookie = token
const cookie = `${sessionCookieName()}=${providedCookie}`
const hashToken = (t: string): string => createHmac('sha256', process.env.SESSION_SECRET ?? '').update(`tok:${t}`).digest('hex')
let sessionId: string | null = null
let channelContract: string | null = null

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as Record<string, any> | null
  console.log(`\n== POST ${path} -> HTTP ${res.status}`)
  if (data && Array.isArray(data.steps)) {
    console.log('  steps:', data.steps.map((s: any) => s.step).join(' -> '))
  }
  if (data && typeof data.sessionId === 'string') sessionId = data.sessionId
  if (data && typeof data.channelContract === 'string') channelContract = data.channelContract
  // A compact, censor-safe projection of the response.
  const { steps: _s, ...rest } = data ?? {}
  console.log('  body:', JSON.stringify(rest, null, 2).slice(0, 1200))
  if (!res.ok) throw new Error(`route failed: ${res.status}`)
}

try {
  await post('/api/playground/session', { slug })
  if (!sessionId || !channelContract) throw new Error('open did not return sessionId/channelContract')
  await post('/api/playground/session/request', { slug, channelContract, count: 4 })
  await post('/api/playground/session/settle', { slug, sessionId })
  console.log('\nALL ROUTES OK')
} finally {
  db().delete(sessions).where(eq(sessions.id, hashToken(providedCookie.split('.')[0] ?? ''))).run()
}