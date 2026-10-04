'use server'

import { headers } from 'next/headers'
import { consumeLoginAttempt, requireUser } from '@/lib/auth/session'
import { requireRole } from '@/lib/auth/identity'
import {
  addListEntry,
  createPolicy,
  removeListEntry,
  setPolicyServices,
  updatePolicy,
  type ListName,
  type PolicyFailure,
  type PolicyInput,
} from '@/lib/policy/manage'

/**
 * Create and edit access policies.
 *
 * Thin by design, exactly as `services/actions.ts` is: identity and throttling here, every
 * decision about what gets written in `@/lib/policy/manage` where it can be proven without a
 * browser.
 *
 * Authorization is OPERATOR, not owner, because the schema says an operator "manages services,
 * policies and review". Only the treasury is owner-only.
 *
 * `unauthenticated` is kept distinct from `forbidden` throughout: "sign in" and "ask someone who
 * can" are different instructions, and merging them is what makes a permissions problem look like
 * a login problem.
 */

export type PolicyActionFailure =
  | PolicyFailure
  | 'unauthenticated'
  | 'forbidden'
  | 'throttled'

export type PolicyActionResult =
  | { ok: true; policyId: string; warning?: string }
  | { ok: false; failure: PolicyActionFailure }

async function throttleKey(): Promise<string> {
  const hdrs = await headers()
  const fwd = hdrs.get('x-forwarded-for')
  const ip = fwd?.split(',')[0]?.trim() || hdrs.get('x-real-ip') || 'local'
  return ip.slice(0, 64)
}

type AuthorizeResult =
  | { ok: true; organizationId: string }
  | { ok: false; failure: PolicyActionFailure }

/** Resolve the caller's organization, or report why not. Never leaks the id on failure. */
async function authorize(): Promise<AuthorizeResult> {
  try {
    const user = await requireUser()
    requireRole(user.id, user.organizationId, 'operator')
    return { ok: true, organizationId: user.organizationId }
  } catch (error) {
    const failure: PolicyActionFailure =
      error instanceof Error && error.message === 'unauthenticated' ? 'unauthenticated' : 'forbidden'
    return { ok: false, failure }
  }
}

/**
 * One shared throttle bucket for policy mutation.
 *
 * Keyed per IP and shared across the four mutations rather than per action, so the ceiling is a
 * real bound on how fast one caller can rewrite access control, not four times that.
 */
async function throttle(): Promise<PolicyActionResult | null> {
  if (!consumeLoginAttempt(`policy:${await throttleKey()}`).allowed) {
    return { ok: false, failure: 'throttled' }
  }
  return null
}

export async function createPolicyAction(input: PolicyInput): Promise<PolicyActionResult> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const limited = await throttle()
  if (limited) return limited
  return createPolicy(auth.organizationId, input)
}

export async function updatePolicyAction(
  policyId: string,
  input: PolicyInput,
): Promise<PolicyActionResult> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const limited = await throttle()
  if (limited) return limited
  return updatePolicy(auth.organizationId, policyId, input)
}

export async function addPolicyListAction(
  policyId: string,
  list: ListName,
  wallet: string,
  label?: string,
  reason?: string,
): Promise<PolicyActionResult> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const limited = await throttle()
  if (limited) return limited
  return addListEntry(auth.organizationId, policyId, list, wallet, label, reason)
}

export async function removePolicyListAction(
  policyId: string,
  list: ListName,
  wallet: string,
): Promise<PolicyActionResult> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const limited = await throttle()
  if (limited) return limited
  return removeListEntry(auth.organizationId, policyId, list, wallet)
}

export async function setPolicyServicesAction(
  policyId: string,
  serviceIds: string[],
): Promise<PolicyActionResult> {
  const auth = await authorize()
  if (!auth.ok) return auth
  const limited = await throttle()
  if (limited) return limited
  return setPolicyServices(auth.organizationId, policyId, serviceIds)
}
