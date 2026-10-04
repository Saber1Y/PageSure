'use client'

import { getAddress, getNetworkDetails, isConnected, requestAccess, signMessage } from '@stellar/freighter-api'

/**
 * Browser-side Stellar wallet access.
 *
 * Freighter is NOT reached through `window.freighter`. Current Freighter talks to the page
 * with window.postMessage:
 *
 *   page    -> { source: "FREIGHTER_EXTERNAL_MSG_REQUEST", messageId, type: "REQUEST_..." }
 *   Freighter -> { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId, ...payload }
 *
 * `window.freighter` survives only as a legacy shortcut, and @stellar/freighter-api prefers
 * it when present and falls back to the messaging path when it is not. Reading the global
 * directly therefore only works on older builds: on a current Freighter the global can be
 * absent while the extension is installed, unlocked and perfectly capable of signing, and
 * the dApp looks broken because nothing is ever sent to prompt it.
 *
 * So every call here goes through the official API. That also means each call is async by
 * design, which is the point: it is what makes the wallet prompt instead of us guessing
 * whether it is there.
 *
 * Kept out of src/lib/auth/* on purpose: that module is server-only (it reads
 * process.env), and this one runs in the browser.
 */

export type WalletDetection =
  /**
   * Extension reachable and answering.
   *
   * publicKey is the address the extension REPORTS it will sign with. It is an untrusted
   * client-side claim, NOT proof of the signer: an extension can report one account and
   * sign with another. Callers may use it to warn the user early, but must never block on
   * it — only the server-side signature check can decide who authenticated.
   */
  | { kind: 'ready'; network: string | null; publicKey: string | null }
  /** Reachable, but refusing because it is locked or has not granted this site access. */
  | { kind: 'locked'; detail: string }
  /** Reachable, but refused for some other reason (declined prompt, unknown failure). */
  | { kind: 'error'; detail: string }
  /** Nothing answered the request. */
  | { kind: 'absent' }

function detailOf(error: unknown): string {
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object' && 'error' in error) {
    const e = (error as { error?: unknown }).error
    if (typeof e === 'string' && e) return e
  }
  return ''
}

/** Freighter reports a locked or not-yet-connected wallet through these wordings. */
function looksUnavailable(text: string): boolean {
  return /lock|unlock|password|not\s*logged|not\s*allow|not\s*connect|permission/i.test(text)
}

/**
 * Ask the extension whether it is reachable, and whether it will actually talk to us.
 *
 * `isConnected()` has a short built-in timeout for the status probe, so this does not hang
 * when no extension is listening.
 */
export async function detectWallet(): Promise<WalletDetection> {
  if (typeof window === 'undefined') return { kind: 'absent' }

  let reachable = false
  try {
    // Two attempts, not a poll loop. The extension's listener can miss the first probe:
    // postMessage only reaches listeners that exist at post time, and an extension still
    // booting registers its listener just after the page did. A second attempt, spaced out,
    // catches that race without the unbounded polling the old global-read version needed.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 700))
      const res = await isConnected()
      if (res?.isConnected) {
        reachable = true
        break
      }
    }
  } catch {
    return { kind: 'absent' }
  }
  if (!reachable) return { kind: 'absent' }

  // Reachable is not the same as usable: an extension that is locked, or that has not been
  // granted this origin, answers the status probe but refuses the account request.
  let publicKey: string | null = null
  try {
    const res = await getAddress()
    publicKey = res?.address ?? null
    if (res?.error) {
      // Distinguish "locked / not allowed" from every other refusal. Reporting a declined
      // prompt as "your wallet is locked" sends the user to fix the wrong thing.
      const detail = detailOf(res.error)
      return looksUnavailable(detail)
        ? { kind: 'locked', detail: detail || 'The wallet has not been connected to this site yet.' }
        : { kind: 'error', detail: detail || 'The wallet refused the request.' }
    }
  } catch (err) {
    const detail = detailOf(err)
    if (looksUnavailable(detail)) return { kind: 'locked', detail }
  }

  let network: string | null = null
  try {
    const res = await getNetworkDetails()
    if (res?.network) network = res.network
  } catch {
    // Advisory only: a challenge signature is network-agnostic.
  }

  // The resolved address travels with the result on purpose: it is the only place the client
  // learns WHICH account will sign, which is what makes a pre-sign mismatch check possible.
  return { kind: 'ready', network, publicKey }
}

/**
 * Prompt the wallet for site access.
 *
 * Without this the extension has never been asked to talk to this origin, which is the
 * reason a dApp can be fully installed and still show no prompt at all. Safe to call when
 * access already exists.
 */
export async function promptWalletAccess(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await requestAccess()
    if (res?.error) return { ok: false, error: detailOf(res.error) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: detailOf(err) || 'Could not reach the wallet extension.' }
  }
}

export type SignResult = { ok: true; signature: string } | { ok: false; error: string }

/**
 * Base64-encode a signature given as bytes.
 *
 * Browser-native on purpose: this module is bundled for the client, where `Buffer` does not
 * exist. The server verifier expects standard base64 either way.
 */
function toBase64(value: unknown): string {
  if (typeof value === 'string') return value
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null
  if (!bytes) return ''
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Ask the wallet to sign the server-issued challenge. */
export async function signChallenge(message: string): Promise<SignResult> {
  try {
    const res = await signMessage(message)
    if (res?.error) {
      return { ok: false, error: detailOf(res.error) }
    }
    const signature = res?.signedMessage
    if (!signature) {
      return { ok: false, error: 'The wallet returned no signature.' }
    }
    // Freighter returns a base64 string. Older builds returned raw bytes, so normalise both
    // shapes to the base64 the server-side verifier expects.
    const encoded = toBase64(signature)
    if (!encoded) return { ok: false, error: 'The wallet returned an unreadable signature.' }
    return { ok: true, signature: encoded }
  } catch (err) {
    return { ok: false, error: detailOf(err) || 'Could not reach the wallet extension.' }
  }
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
      return `Freighter is installed but not ready: ${detection.detail} Unlock it and allow this site, then try again.`
    case 'error':
      return /reject|cancel|denied|declin/i.test(detection.detail)
        ? `Freighter declined the request: ${detection.detail}`
        : `Freighter could not be used: ${detection.detail}`
    case 'absent':
      return 'No Stellar wallet detected. If Freighter is installed, unlock it, allow it on this site using the puzzle-piece icon in the address bar, then reload this page.'
    case 'ready':
      return 'Freighter is ready.'
  }
}

/**
 * A snapshot of what the page can see, for when detection fails.
 *
 * "No wallet detected" is not actionable on its own, so the facts are worth showing: the
 * origin the page is really on, and whether any wallet global exists at all (which tells us
 * whether this is a legacy-global path or the postMessage path).
 *
 * Reading a global can throw (some extensions define throwing getters), so every access is
 * guarded: a probe must never be the thing that breaks the login page.
 */
export interface WalletProbe {
  origin: string
  globals: string[]
}

export function probeWallets(): WalletProbe {
  const probe: WalletProbe = { origin: 'unavailable', globals: [] }
  if (typeof window === 'undefined') return probe
  probe.origin = window.location?.origin ?? 'unknown'

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
    try {
      if ((window as unknown as Record<string, unknown>)[key]) probe.globals.push(key)
    } catch {
      // A throwing getter says nothing useful; ignore it.
    }
  }
  return probe
}