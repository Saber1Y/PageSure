/**
 * Outbound email.
 *
 * Email is now the primary credential, so "the link was not sent" is a first-class failure
 * mode rather than a cosmetic one. A deployment with no provider configured must say so
 * loudly at call time instead of logging a line and reporting success: the alternative is an
 * operator watching a sign-in screen that accepts an address and then never receiving
 * anything, with nothing in the logs to explain it.
 *
 * Transport is native `fetch` against the provider's REST API rather than an SDK. The call is
 * one POST of a JSON body, and an SDK for it would add a dependency that has to be audited
 * and upgraded for the privilege of saving twenty lines. It also keeps the signing path free
 * of transitive dependencies that execute during a login.
 *
 * This is the only module in the auth path that talks to a third party, and it is
 * deliberately the only one that can be absent. Everything else is local and synchronous.
 */

export type MailKind = 'signin' | 'invite'

export interface OutboundMail {
  to: string
  kind: MailKind
  /** Absolute URL the recipient follows. Built by the caller, which knows the public origin. */
  href: string
  organizationName?: string
  inviterName?: string
}

export class MailDeliveryError extends Error {
  /**
   * Transport or provider detail, kept apart from the message on purpose.
   *
   * `message` is what a browser is allowed to see. `detail` is for the server log only, because
   * a provider rejection body carries the account's own address, provider identifiers and
   * internal error names - and this error is returned straight to the page that asked for the
   * mail. Folding the two together is how "the mail provider rejected the message" turns into a
   * support answer that volunteers the Resend account's email address to anyone who can submit
   * a form.
   */
  readonly detail?: string

  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'MailDeliveryError'
    this.detail = detail
  }
}

function apiKey(): string | null {
  const key = process.env.RESEND_API_KEY?.trim()
  return key ? key : null
}

/**
 * The origin the emailed link points at.
 *
 * Taken from configuration, never from the request. A link built from a Host header would
 * let an attacker send a victim a genuine PageSure sign-in link that resolves to their own
 * domain, which is a complete account takeover delivered by our own mailer.
 */
import { safeReturnTo } from '@/lib/auth/return-to'

export function publicOrigin(): string {
  // PAGESURE_PUBLIC_ORIGIN wins, APP_URL is the fallback. A sign-in link has to point at
  // whichever origin the person is actually looking at, and a deployment that already declares
  // its canonical URL should not have to declare it twice to be able to send anybody a link.
  const raw = (
    process.env.PAGESURE_PUBLIC_ORIGIN?.trim() || process.env.APP_URL?.trim() || ''
  )
  if (!raw) {
    throw new MailDeliveryError(
      'neither PAGESURE_PUBLIC_ORIGIN nor APP_URL is set, so there is no origin to build a sign-in link against',
    )
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new MailDeliveryError('PAGESURE_PUBLIC_ORIGIN is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    // A sign-in link is a credential. Serving it over plain HTTP to anything other than a
    // local development origin would put it on the wire in the clear.
    throw new MailDeliveryError('PAGESURE_PUBLIC_ORIGIN must be https, or localhost for development')
  }
  return url.origin
}

export function signinHref(token: string, returnTo?: string): string {
  const url = new URL('/login/callback', publicOrigin())
  url.searchParams.set('token', token)
  const safe = safeReturnTo(returnTo, '')
  if (safe) url.searchParams.set('returnTo', safe)
  return url.toString()
}

export function inviteHref(token: string): string {
  const url = new URL('/invite/callback', publicOrigin())
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * Subjects are fixed strings, with the organization name carried only where it is a display
 * value the recipient already expects.
 *
 * An organization name is operator-supplied text that reaches an inbox, so the branch that
 * includes it must never be a place where arbitrary content can introduce a fake support
 * address or a second header. A fixed prefix plus a name is safe; concatenating a "from" or
 * a reply-to into it would not be.
 */
function subjectFor(mail: OutboundMail): string {
  if (mail.kind === 'signin') return 'Your PageSure sign-in link'
  return `Join ${mail.organizationName ?? 'an organization'} on PageSure`
}

function textBody(mail: OutboundMail): string {
  if (mail.kind === 'signin') {
    return [
      'Sign in to PageSure:',
      '',
      mail.href,
      '',
      'The link works once and expires in 15 minutes.',
      '',
      'If you did not request it, you can ignore this message. Nobody can sign in without it.',
    ].join('\n')
  }
  return [
    `${mail.inviterName ?? 'An owner'} invited you to join ${mail.organizationName ?? 'an organization'} on PageSure.`,
    '',
    mail.href,
    '',
    'The link expires in 7 days.',
  ].join('\n')
}

/** Never let a provider request outlive the user staring at the form. */
const MAIL_TIMEOUT_MS = 10_000

/**
 * Send, or throw.
 *
 * No silent no-op and no queued-forever fallback: if the provider is unconfigured or
 * rejects, the caller must be able to tell the operator that the sign-in email did not go
 * out. Swallowing that failure produces an onboarding flow that appears to work and delivers
 * nothing, which is the worst possible outcome here.
 */
export async function sendMail(mail: OutboundMail): Promise<void> {
  const key = apiKey()
  if (!key) {
    /*
     * Development transport.
     *
     * Without this, the sign-in flow cannot be exercised locally at all: the only way to
     * reach a callback page is to receive a token, and requiring a paid provider to test
     * one's own login page is a poor trade. So outside production, an unconfigured
     * deployment prints the link to the server console and reports success.
     *
     * Two conditions guard it, and both must hold. `NODE_ENV` is checked rather than inferred
     * from the absence of configuration, because "no API key" is also what a misconfigured
     * production deployment looks like, and that deployment must fail loudly instead of
     * printing live credentials into whatever collects its logs.
     */
    if (process.env.NODE_ENV !== 'production' && process.env.PAGESURE_DEV_MAIL !== 'off') {
      console.warn(
        `[pagesure] email delivery is not configured; printing the ${mail.kind} message\n` +
          `[pagesure] to: ${mail.to}\n` +
          `[pagesure] link: ${mail.href}\n` +
          `[pagesure] set RESEND_API_KEY to send real mail, or PAGESURE_DEV_MAIL=off to fail instead.`,
      )
      return
    }
    throw new MailDeliveryError(
      'email delivery is not configured on this deployment (RESEND_API_KEY is unset)',
    )
  }
  // Validate before spending a network round trip, and validate the href itself: a
  // javascript: or data: URL in an email body is a phishing payload with our domain on it.
  let parsed: URL
  try {
    parsed = new URL(mail.href)
  } catch {
    throw new MailDeliveryError('the sign-in link is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MailDeliveryError('the sign-in link must be an http(s) URL')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS)
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM?.trim() || 'PageSure <onboarding@resend.dev>',
        to: [mail.to],
        subject: subjectFor(mail),
        text: textBody(mail),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      // The provider body goes to the log, not to the browser. It is the only place the real
      // reason appears, and it is also the place the account's own address and provider
      // internals appear, so the two are kept apart by MailDeliveryError.detail.
      const detail = await response.text().catch(() => '')
      throw new MailDeliveryError(
        'the mail provider rejected the message',
        `HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      )
    }
  } catch (error) {
    if (error instanceof MailDeliveryError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MailDeliveryError('the mail provider did not respond in time')
    }
    throw new MailDeliveryError(error instanceof Error ? error.message : 'the message could not be sent')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver the link, or return why it could not be delivered.
 *
 * Returning rather than throwing is deliberate for the sign-in path: the operator sitting in
 * front of the form needs to be told the truth, and the caller renders whatever reason comes
 * back. The address itself is never echoed into the message, so the response cannot be used
 * to confirm which addresses have accounts.
 */
export async function deliverSigninLink(input: {
  to: string
  token: string
  /**
   * Where the recipient should land once the link is redeemed.
   *
   * Traveled in the emailed link rather than in browser state, because the recipient arrives by
   * clicking a link in a different device context than the one that requested it. Everything
   * stored in a cookie or in sessionStorage is simply gone by then.
   */
  returnTo?: string
}): Promise<{ delivered: true } | { delivered: false; reason: string }> {
  try {
    await sendMail({
      to: input.to,
      kind: 'signin',
      href: signinHref(input.token, input.returnTo),
    })
    return { delivered: true }
  } catch (error) {
    // The operator gets the real reason and the recipient; the browser gets neither the provider
    // body nor the address it was addressed to.
    if (error instanceof MailDeliveryError && error.detail) {
      console.error(`[pagesure] sign-in mail to ${input.to} failed: ${error.detail}`)
    }
    return {
      delivered: false,
      reason: error instanceof Error ? error.message : 'the message could not be sent',
    }
  }
}

/**
 * Deliver an organization invitation.
 *
 * Reported as a result rather than thrown, for the same reason `deliverSigninLink` is: the
 * caller has to be able to tell the inviter that nothing was sent, and an exception escaping
 * into a server action boundary turns into a generic 500 that says nothing useful.
 */
export async function deliverInvitation(input: {
  to: string
  token: string
  organizationName: string
  inviterName: string
}): Promise<{ delivered: true } | { delivered: false; reason: string }> {
  try {
    await sendMail({
      to: input.to,
      kind: 'invite',
      href: inviteHref(input.token),
      organizationName: input.organizationName,
      inviterName: input.inviterName,
    })
    return { delivered: true }
  } catch (error) {
    if (error instanceof MailDeliveryError && error.detail) {
      console.error(
        `[pagesure] invitation mail to ${input.to} for ${input.organizationName} failed: ${error.detail}`,
      )
    }
    return {
      delivered: false,
      reason: error instanceof Error ? error.message : 'the message could not be sent',
    }
  }
}
