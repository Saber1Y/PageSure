import { request } from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { UpstreamError, type UpstreamContext } from '@/lib/upstream'

/**
 * A provider's own HTTPS API as the upstream.
 *
 * This is the one adapter that sends traffic to a URL a tenant typed, so it is written around
 * what that URL could be used for besides calling an API:
 *
 *   - Only https on the default port. No plain http, no embedded credentials, no odd ports
 *     that tend to belong to internal services.
 *   - Every address the hostname resolves to is checked against private, loopback,
 *     link-local, carrier-grade NAT, multicast and cloud-metadata ranges, inside the socket's
 *     own DNS lookup. Checking at connect time rather than at save time is what defeats a name
 *     that resolves publicly when the service is created and to 127.0.0.1 later.
 *   - Redirects are not followed, so a public endpoint cannot bounce the request inward.
 *   - Nothing from the caller's request headers is forwarded: an agent's Authorization or
 *     PageSure's own payment headers never reach the provider's server.
 *   - The response is capped, and the call shares the gateway's upstream deadline.
 *
 * What it forwards is the caller's query string (minus PageSure's own `payer` and `review`
 * parameters) and, for a POST, the JSON body. A JSON response is returned as JSON; anything
 * else as text with its content type.
 */

const MAX_RESPONSE_BYTES = 1_000_000
/** PageSure's own query parameters, which mean nothing to the provider's API. */
const RESERVED_PARAMS = ['payer', 'review']

// Two lists, one per family. A single BlockList holding the IPv6 rule ::ffff:0:0/96 also matches
// every plain IPv4 address, because it treats IPv4 as IPv4-mapped IPv6; that would refuse the
// whole public internet. Mapped addresses are unwrapped and judged as IPv4 instead.
const blockedV4 = new BlockList()
const blockedV6 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedV6.addSubnet(net, prefix, 'ipv6')

/** True when an address is not a public, routable unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return true
  if (family === 6) {
    // An IPv4-mapped IPv6 address is judged by the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return blockedV4.check(mapped[1]!, 'ipv4')
    return blockedV6.check(address, 'ipv6')
  }
  return blockedV4.check(address, 'ipv4')
}

export type UpstreamUrlCheck = { ok: true; url: string } | { ok: false; reason: string }

/**
 * Validate a provider-entered upstream URL. Run when the service is saved, and again before
 * every call, so a stored value can never skip the rules. DNS is checked separately at connect
 * time, because a name's answer can change after this passes.
 */
export function checkUpstreamUrl(raw: string): UpstreamUrlCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'Enter a full URL, for example https://api.example.com/v1/quote.' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The API URL must use https.' }
  if (url.username || url.password) return { ok: false, reason: 'The API URL must not contain a username or password.' }
  if (url.port && url.port !== '443') return { ok: false, reason: 'The API URL must use the standard https port (443).' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host.includes('.') && isIP(host) === 0) return { ok: false, reason: 'The API URL must use a public domain name.' }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'The API URL must be reachable on the public internet.' }
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    return { ok: false, reason: 'The API URL must be reachable on the public internet.' }
  }
  url.hash = ''
  return { ok: true, url: url.toString() }
}

/** DNS lookup that refuses to hand the socket any non-public address. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[]
    const bad = list.find((a) => isBlockedAddress(a.address))
    if (!list.length || bad) {
      const refused = Object.assign(new Error(`refused to connect to non-public address for ${hostname}`), {
        code: 'EPAGESURE_BLOCKED_ADDRESS',
      })
      return callback(refused, '', 0)
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
    return callback(null, list[0]!.address, list[0]!.family)
  })
}

export async function runHttp(ctx: UpstreamContext): Promise<{ provider: string; status: number; body: unknown }> {
  const checked = checkUpstreamUrl(String(ctx.config.url ?? ''))
  if (!checked.ok) throw new UpstreamError('http', `this service's API URL is not usable: ${checked.reason}`, 500)
  const target = new URL(checked.url)
  const provider = target.host

  for (const [key, value] of ctx.search) {
    if (!RESERVED_PARAMS.includes(key)) target.searchParams.append(key, value)
  }
  const hasBody = ctx.body !== undefined && ctx.body !== null
  const payload = hasBody ? Buffer.from(JSON.stringify(ctx.body)) : null

  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: payload ? 'POST' : 'GET',
        lookup: guardedLookup,
        signal: ctx.signal,
        headers: {
          accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
          'user-agent': 'PageSure-Gateway/1.0',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy()
            reject(new UpstreamError(provider, `${provider} returned more than ${MAX_RESPONSE_BYTES} bytes`, 502))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', (error) => reject(new UpstreamError(provider, `${provider}: ${error.message}`, 502)))
        res.on('end', () => {
          if (size > MAX_RESPONSE_BYTES) return
          if (status >= 300 && status < 400) {
            return reject(new UpstreamError(provider, `${provider} answered with a redirect (HTTP ${status}); redirects are not followed`, 502))
          }
          if (status < 200 || status >= 300) {
            return reject(new UpstreamError(provider, `${provider} returned HTTP ${status}`, 502))
          }
          const text = Buffer.concat(chunks).toString('utf8')
          const contentType = String(res.headers['content-type'] ?? '')
          if (/\bjson\b/i.test(contentType)) {
            try {
              return resolve({ provider, status: 200, body: JSON.parse(text) })
            } catch {
              return reject(new UpstreamError(provider, `${provider} sent invalid JSON`, 502))
            }
          }
          resolve({ provider, status: 200, body: { contentType, text } })
        })
      },
    )
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') return reject(new UpstreamError(provider, `${provider} did not answer in time`, 504))
      const message = error.code === 'EPAGESURE_BLOCKED_ADDRESS'
        ? `${provider} resolves to a non-public address; the call was refused`
        : `${provider}: ${error.message}`
      reject(new UpstreamError(provider, message, 502))
    })
    if (payload) req.write(payload)
    req.end()
  })
}
