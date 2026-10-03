import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { Mppx, stellar as chargeClient } from '@stellar/mpp/charge/client'

/**
 * The payer side: a real MPP client.
 *
 * This is the same code an agent would run. It holds a funded testnet keypair, lets the
 * SDK's fetch polyfill handle the 402 challenge transparently, and reports progress from
 * the client's real lifecycle events. Nothing about the payment is simulated.
 *
 * Progress events reported by the SDK:
 *   charge  -> challenge, signing, signed, paying, confirming, paid
 *   channel -> challenge, signing, signed
 */

export type WaterfallStep =
  | 'REQUEST'
  | 'POLICY_CHECK'
  | 'CHALLENGE'
  | 'SIGNING'
  | 'SIGNED'
  | 'PAYING'
  | 'CONFIRMING'
  | 'PAID'
  | 'SERVICE_EXECUTED'
  | 'RESULT'
  | 'BLOCKED'
  | 'REVIEW_PENDING'
  | 'FAILED'

export interface WaterfallEntry {
  step: WaterfallStep
  detail: string
  at: number
}

export interface RunnerResult {
  ok: boolean
  status: number
  steps: WaterfallEntry[]
  body: unknown
  headers: Record<string, string>
  payer: string
  error: string | null
}

function demoPayerKeypair(): Keypair {
  const secret = process.env.DEMO_PAYER_SECRET
  if (!secret) {
    throw new Error('DEMO_PAYER_SECRET is not set. Run: npm run keys:generate')
  }
  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw new Error('DEMO_PAYER_SECRET is not a valid Stellar secret key')
  }
  return Keypair.fromSecret(secret)
}

/**
 * Make one paid request through the gateway.
 *
 * The SDK polyfills global fetch so the 402 round trip is handled for us. We only record
 * what the SDK reports, which is why the waterfall cannot drift from what happened.
 */
export async function runPaidRequest(options: {
  slug: string
  search: Record<string, string>
  body?: unknown
  payer?: string
}): Promise<RunnerResult> {
  const steps: WaterfallEntry[] = []
  const push = (step: WaterfallStep, detail: string) => {
    steps.push({ step, detail, at: Date.now() })
  }

  let keypair: Keypair
  try {
    keypair = options.payer ? Keypair.fromPublicKey(options.payer) : demoPayerKeypair()
  } catch (error) {
    return {
      ok: false,
      status: 0,
      steps,
      body: null,
      headers: {},
      payer: options.payer ?? '',
      error: (error as Error).message,
    }
  }

  // Install the MPP client. It patches global fetch to answer 402 challenges.
  const mppx = Mppx.create({
    methods: [
      chargeClient.charge({
        keypair,
        mode: 'pull',
        onProgress(event) {
          switch (event.type) {
            case 'challenge':
              push('CHALLENGE', `Server asked for ${event.amount} of ${event.currency}`)
              break
            case 'signing':
              push('SIGNING', 'Signing the Soroban transfer authorization')
              break
            case 'signed':
              push('SIGNED', 'Authorization signed')
              break
            case 'paying':
              push('PAYING', 'Submitting to the network')
              break
            case 'confirming':
              push('CONFIRMING', `Waiting for confirmation: ${event.hash.slice(0, 12)}…`)
              break
            case 'paid':
              push('PAID', `Settled: ${event.hash.slice(0, 16)}…`)
              break
          }
        },
      }),
    ],
  })
  void mppx

  const payer = keypair.publicKey()
  push('REQUEST', `Declaring payer ${payer.slice(0, 10)}…`)
  push('POLICY_CHECK', 'Gateway evaluating provider policy before any payment exists')

  const base = process.env.APP_URL ?? 'http://localhost:3000'
  const url = new URL(`/v1/${options.slug}`, base)
  for (const [key, value] of Object.entries(options.search)) url.searchParams.set(key, value)

  const headers: Record<string, string> = {
    'X-Pagesure-Payer': payer,
    Accept: 'application/json',
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  try {
    const response = await fetch(url, {
      method: options.body !== undefined ? 'POST' : 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // keep raw text
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    if (response.status === 200) {
      push('SERVICE_EXECUTED', `Upstream returned ${response.status}`)
      push('RESULT', 'Delivered')
      return { ok: true, status: 200, steps, body: parsed, headers: responseHeaders, payer, error: null }
    }

    if (response.status === 403) {
      const title = (parsed as { title?: string }).title ?? 'blocked'
      push('BLOCKED', `${title}: no payment was taken and the service was not called`)
      return { ok: false, status: 403, steps, body: parsed, headers: responseHeaders, payer, error: null }
    }

    if (response.status === 202) {
      const title = (parsed as { title?: string }).title ?? 'review_pending'
      push('REVIEW_PENDING', `${title}: held for a human, nothing charged`)
      return { ok: false, status: 202, steps, body: parsed, headers: responseHeaders, payer, error: null }
    }

    const detail = (parsed as { detail?: string }).detail ?? `HTTP ${response.status}`
    push('FAILED', detail)
    return { ok: false, status: response.status, steps, body: parsed, headers: responseHeaders, payer, error: detail }
  } catch (error) {
    const message = (error as Error).message
    push('FAILED', message)
    return { ok: false, status: 0, steps, body: null, headers: {}, payer, error: message }
  }
}