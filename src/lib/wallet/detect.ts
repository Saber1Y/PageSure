'use client'

/**
 * Browser-side Stellar wallet detection.
 *
 * A wallet extension injects itself into the page as `window.freighter` (or
 * `window.albedo`). Three things make naive detection wrong:
 *
 *   1. Injection is ASYNCHRONOUS. A content script may land after the app's own bundle
 *      runs, so a single read at click time can miss an extension that is present and
 *      working. Everything here polls for a short window instead.
 *
 *   2. "Not injected" is not one state. An extension can be installed but LOCKED, or
 *      injected without being granted access to this site, or on the wrong network. Each
 *      needs a different instruction, and telling someone to install an extension they
 *      already have is the worst possible answer.
 *
 *   3. Detection must not be able to sign anything by itself. This module only ever
 *      returns a handle to the provider the browser already put on the page.
 *
 * Kept out of src/lib/auth/* on purpose: that module is server-only (it reads
 * process.env), and this one runs in the browser.
 */

export type WalletProviderName = 'Freighter' | 'Albedo' | 'xBull'

export interface WalletProvider {
  name: WalletProviderName
  signMessage: (message: string) => Promise<string>
  getPublicKey?: () => Promise<{ publicKey: string; error?: string }>
  getNetwork?: () => Promise<{ network: string; error?: string }>
}

export type WalletDetection =
  /** Injected and usable. publicKey/network may still be unknown if probing failed. */
  | { kind: 'ready'; provider: WalletProvider; publicKey: string | null; network: string | null }
  /** Injected, but the wallet is locked and cannot answer. */
  | { kind: 'locked'; provider: WalletProvider; detail: string }
  /** Nothing injected within the wait window. */
  | { kind: 'absent' }

/** Wallets this app can drive, in preference order. */
const PROVIDERS: { name: WalletProviderName; key: string }[] = [
  { name: 'Freighter', key: 'freighter' },
  { name: 'Albedo', key: 'albedo' },
  { name: 'xBull', key: 'xbull' },
]

function readProvider(name: WalletProviderName, key: string): WalletProvider | null {
  if (typeof window === 'undefined') return null
  const bag = window as unknown as Record<string, unknown>
  const raw = bag[key]
  if (!raw || typeof raw !== 'object') return null
  const api = raw as Record<string, unknown>

  const signMessage = api.signMessage
  if (typeof signMessage !== 'function') return null

  return {
    name,
    // Freighter and xBull both sign UTF-8 strings and return base64. Albedo returns
    // base64url without the trailing padding; both decode fine server-side, so no
    // normalisation is done here that would risk altering the signed bytes.
    signMessage: (message: string) => (signMessage as (m: string) => Promise<string>).call(raw, message),
    getPublicKey:
      typeof api.getPublicKey === 'function'
        ? () => (api.getPublicKey as () => Promise<{ publicKey: string; error?: string }>).call(raw)
        : undefined,
    getNetwork:
      typeof api.getNetwork === 'function'
        ? () => (api.getNetwork as () => Promise<{ network: string; error?: string }>).call(raw)
        : undefined,
  }
}

/**
 * Poll for an injected provider.
 *
 * `timeoutMs` is a ceiling on how long to keep waiting for injection, not a fixed delay:
 * the loop returns as soon as a provider appears.
 */
async function awaitProvider(timeoutMs: number): Promise<WalletProvider | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const p of PROVIDERS) {
      const found = readProvider(p.name, p.key)
      if (found) return found
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 120))
  }
}

/** Freighter/Albedo report a locked wallet through a rejected or errored call. */
function looksLocked(text: string): boolean {
  return /lock|unlock|password|not\s*logged|connect/i.test(text)
}

/**
 * Detect a usable wallet extension.
 *
 * `injectTimeoutMs` should be short enough to feel instant on a real click (the provider
 * is normally there on the first check) but long enough to cover a slow content script.
 */
export async function detectWallet(injectTimeoutMs = 1500): Promise<WalletDetection> {
  const provider = await awaitProvider(injectTimeoutMs)
  if (!provider) return { kind: 'absent' }

  // An injected provider that cannot report a public key is almost always locked. Asking
  // is what separates "locked" from "ready", and it is also the only reliable way to tell
  // the user which of the two problems they have.
  let publicKey: string | null = null
  if (provider.getPublicKey) {
    try {
      const res = await provider.getPublicKey()
      if (res?.publicKey) publicKey = res.publicKey
      else if (res?.error) return { kind: 'locked', provider, detail: res.error }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (looksLocked(detail)) return { kind: 'locked', provider, detail }
      // Some other failure: still allow the attempt, since signMessage may work.
    }
  }

  let network: string | null = null
  if (provider.getNetwork) {
    try {
      const res = await provider.getNetwork()
      if (res?.network) network = res.network
    } catch {
      // Network reporting is advisory here; the challenge is network-agnostic.
    }
  }

  return { kind: 'ready', provider, publicKey, network }
}

/**
 * Instruction text for a detection result.
 *
 * Every message names the concrete next action. "Install Freighter" is wrong for someone
 * who already has it, which is the most common way this goes wrong.
 */
export function walletDetectionMessage(detection: WalletDetection): string {
  switch (detection.kind) {
    case 'locked':
      return `${detection.provider.name} is installed but locked. Open the extension, unlock it, then try again.`
    case 'absent':
      return 'No Stellar wallet detected. If Freighter is installed: unlock it, then allow it on this site using the puzzle-piece icon in the address bar, and reload this page.'
    case 'ready':
      return detection.publicKey
        ? `${detection.provider.name} is ready.`
        : `${detection.provider.name} is ready.`
  }
}

/**
 * A snapshot of what the page can actually see, for when detection fails.
 *
 * "No wallet detected" is not actionable on its own: the extension can be installed, unlocked
 * and rendering its own UI into the page while its provider global is still missing, and the
 * fix differs completely between those cases. Rather than guess from the outside, surface
 * the facts.
 *
 * Reading a global can throw (some extensions define throwing getters), so every access is
 * guarded: a probe must never be the thing that breaks the login page.
 */
export interface WalletProbe {
  origin: string
  globals: { key: string; methods: string[] }[]
  /** Wallet-shaped globals we do not support, in case the provider moved or was renamed. */
  unrecognised: string[]
}

const INTERESTING_METHODS = ['signMessage', 'getPublicKey', 'getNetwork', 'connect', 'signTransaction']

function safeMethodNames(value: unknown): string[] {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return []
    const bag = value as Record<string, unknown>
    return INTERESTING_METHODS.filter((m) => typeof bag[m] === 'function')
  } catch {
    return []
  }
}

export function probeWallets(): WalletProbe {
  const probe: WalletProbe = { origin: 'unavailable', globals: [], unrecognised: [] }
  if (typeof window === 'undefined') return probe
  probe.origin = window.location?.origin ?? 'unknown'

  const known = new Set(PROVIDERS.map((p) => p.key))
  const keys: string[] = []
  try {
    // Own and inherited keys: some extensions hang the provider off a prototype.
    for (const k in window) keys.push(k)
    keys.push(...Object.getOwnPropertyNames(window))
  } catch {
    return probe
  }

  const walletish = /freighter|albedo|xbull|wallet|stellar|phantom|soroban|keplr/i
  for (const key of [...new Set(keys)]) {
    if (!walletish.test(key)) continue
    let value: unknown
    try {
      value = (window as unknown as Record<string, unknown>)[key]
    } catch {
      continue
    }
    if (!value) continue
    const methods = safeMethodNames(value)
    if (known.has(key)) {
      if (methods.length) probe.globals.push({ key, methods })
    } else {
      probe.unrecognised.push(key)
  }
  }
  return probe
}