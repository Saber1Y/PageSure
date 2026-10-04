'use server'

import { headers } from 'next/headers'
import { consumeLoginAttempt, requireUser } from '@/lib/auth/session'
import { requireRole } from '@/lib/auth/identity'
import { createService, type CreateServiceFailure } from '@/lib/services/create'
import { slugify } from '@/lib/services/slug'

/**
 * Publish a service at /v1/:slug.
 *
 * Deliberately thin. It supplies the two things a lib function must never reach for - who the
 * caller is and whether they are throttled - and delegates every decision about what gets written
 * to `createService`, which is where the provable logic lives.
 *
 * AUTHORIZATION IS OPERATOR, NOT OWNER. The schema comment is explicit that an operator
 * "manages services, policies and review" and that only the treasury is owner-only. Making
 * service creation owner-only would contradict the documented role model and stop exactly the
 * people the product exists for.
 *
 * `requireRole` reports `not_a_member` before `insufficient_role`, deliberately, so this cannot be
 * used to discover whether an address belongs to this organization. Both collapse to `forbidden`
 * here because the two are not a distinction the caller can act on: either way the answer is to
 * ask someone who can.
 *
 * `unauthenticated` is kept distinct because it is a real difference for the user - sign in, or
 * ask an owner - and conflating them is what makes a permissions problem look like a login
 * problem.
 */

export type ServiceFailure = CreateServiceFailure | 'unauthenticated' | 'forbidden' | 'throttled'

export type CreateServiceResult =
  | { ok: true; serviceId: string; policyCreated: boolean }
  | { ok: false; failure: ServiceFailure; detail?: string }

async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const fwd = hdrs.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || 'local'
  return ip.slice(0, 64)
}

/** Slug suggested from the name, for the form to prefill. Never trusted for storage. */
export async function suggestSlugAction(name: string): Promise<string> {
  return slugify(name)
}

export async function createServiceAction(input: {
  name: string
  slug: string
  description?: string
  price: string
  upstreamKind: string
  mode?: string
  policyId?: string
  status?: string
}): Promise<CreateServiceResult> {
  let organizationId = ''
  try {
    const user = await requireUser()
    requireRole(user.id, user.organizationId, 'operator')
    organizationId = user.organizationId
  } catch (error) {
    const failure: ServiceFailure =
      error instanceof Error && error.message === 'unauthenticated' ? 'unauthenticated' : 'forbidden'
    return { ok: false, failure }
  }

  // Publishing is cheap but permanently public surface, so it shares a throttle rather than being
  // left unbounded behind a session.
  if (!consumeLoginAttempt(`service:${await throttleKey()}`).allowed) {
    return { ok: false, failure: 'throttled' }
  }

  return createService({ organizationId, ...input })
}
