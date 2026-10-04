/**
 * Test-only overrides for the two boundaries the gateway cannot exercise offline.
 *
 * The charge pipeline's whole job is to take money and then deliver a resource, which means it
 * cannot be proven without either a funded account or two substitutions. Both exist here rather
 * than as hooks sprinkled through the call sites, so there is exactly one place to look to answer
 * "can production be substituting anything?", and the answer is checkable by reading this file:
 * nothing is overridden unless a test sets it.
 *
 * Why this module exists at all: `prove:settlement` grew to 49 checks and never once called the
 * charge route. It proved that payments are correctly REFUSED while a successful payment was
 * unreachable - the route returned 400 after the money had already moved, and no assertion could
 * see it. `prove:charge` exists to close that, and it needs these two seams to do it without a
 * network or a faucet.
 *
 * Rules for callers:
 *   - production code reads these, never writes them
 *   - only a script under scripts/ may write them
 *   - every proof resets them on exit, so one suite cannot silently disarm another's gateway
 */

export interface ChargeOverrideArgs {
  recipient: string
  currency: string
}

/** The subset of the mppx surface the gateway actually calls. */
export interface FakeCharge {
  charge(parameters: {
    amount: string
    description: string
    externalId: string
  }): (request: Request) => Promise<unknown>
}

export type ChargeFactory = (args: ChargeOverrideArgs) => FakeCharge

export interface UpstreamResult {
  provider: string
  status: number
  body: unknown
}

export type UpstreamRunner = (ctx: {
  serviceId: string
  serviceName: string
  upstreamKind: string
  config: Record<string, unknown>
  search: URLSearchParams
  body: unknown
}) => Promise<UpstreamResult>

let chargeFactory: ChargeFactory | null = null
let upstreamRunner: UpstreamRunner | null = null

/** Replace the mppx instance factory. Pass null to restore the real one. */
export function setChargeFactory(fn: ChargeFactory | null): void {
  chargeFactory = fn
}

/** Replace the upstream adapter dispatch. Pass null to restore the real one. */
export function setUpstreamRunner(fn: UpstreamRunner | null): void {
  upstreamRunner = fn
}

export function chargeFactoryOverride(): ChargeFactory | null {
  return chargeFactory
}

export function upstreamRunnerOverride(): UpstreamRunner | null {
  return upstreamRunner
}

/** Restore both. Every proof that sets an override must call this. */
export function resetOverrides(): void {
  chargeFactory = null
  upstreamRunner = null
}
