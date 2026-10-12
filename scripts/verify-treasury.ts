/**
 * Operator treasury verification, for a settlement account whose key lives in a signer service
 * rather than in a browser wallet.
 *
 * The Settings page proves control of a treasury with a SEP-53 signature from Freighter. A
 * session (channel) treasury cannot use that path: its key belongs to the provider signer, which
 * must hold it to authorize the close, and importing it into a browser wallet only to answer one
 * challenge would put it somewhere it does not belong. This script answers the same challenge
 * with the same key, through the same functions the Settings actions use:
 *
 *   issueChallenge -> storeChallenge (bound to org + wallet) -> SEP-53 sign
 *   -> consumeChallenge -> verifyChallengeSignature -> setSettlementWallet
 *
 * so the organization's treasury is only marked verified after the key has signed a challenge
 * minted for that organization and that wallet. Optionally it then registers the external
 * signer through validateSignerRegistration, which enforces the https + MPP_SIGNER_HOSTS +
 * MPP_SIGNER_TOKEN_PREFIX rules exactly as the Settings form does.
 *
 * Environment (secrets are named, never passed as values):
 *   VERIFY_ORG_ID              organization to verify (required)
 *   VERIFY_TREASURY_SECRET_ENV name of the env var holding the treasury secret
 *                              (default SESSION_TREASURY_SECRET)
 *   VERIFY_SIGNER_URL          optional https base URL of the organization signer
 *   VERIFY_SIGNER_TOKEN_ENV    env var name of the signer token, required with the URL
 *
 * Refuses to run unless STELLAR_NETWORK=stellar:testnet. Prints public keys and ids only.
 */
import { eq } from 'drizzle-orm'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { db, closeDatabase } from '../src/lib/db/client'
import { loginChallenges, organizations } from '../src/lib/db/schema'
import { challengeBytes, issueChallenge, verifyChallengeSignature } from '../src/lib/auth/wallet'
import { consumeChallenge, storeChallenge } from '../src/lib/auth/session'
import { organizationById, setSettlementWallet } from '../src/lib/auth/identity'
import { validateSignerRegistration } from '../src/lib/mpp/signer-registration'

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`verify-treasury: ${message}`)
}

function main(): void {
  assert(process.env.STELLAR_NETWORK === 'stellar:testnet', 'refusing to run unless STELLAR_NETWORK=stellar:testnet')

  const organizationId = process.env.VERIFY_ORG_ID?.trim() ?? ''
  assert(organizationId, 'VERIFY_ORG_ID is required')
  assert(organizationById(organizationId), `organization ${organizationId} not found`)

  const secretEnv = process.env.VERIFY_TREASURY_SECRET_ENV?.trim() || 'SESSION_TREASURY_SECRET'
  const secret = process.env[secretEnv]?.trim() ?? ''
  assert(StrKey.isValidEd25519SecretSeed(secret), `${secretEnv} is missing or not a valid secret seed`)
  const treasury = Keypair.fromSecret(secret)
  const wallet = treasury.publicKey()

  // Validate the signer registration before writing anything, so a refused signer cannot leave
  // the organization half-configured.
  const signerUrl = process.env.VERIFY_SIGNER_URL?.trim() ?? ''
  const signerTokenEnv = process.env.VERIFY_SIGNER_TOKEN_ENV?.trim() ?? ''
  let verdict: { signerUrl: string; signerTokenEnv: string } | null = null
  if (signerUrl || signerTokenEnv) {
    const result = validateSignerRegistration({ signerUrl, signerTokenEnv })
    assert(result.ok, `signer registration refused: ${result.ok ? '' : result.reason}`)
    assert(process.env[result.signerTokenEnv], `${result.signerTokenEnv} is not set in this environment`)
    verdict = result
  }

  // The same two steps as requestTreasuryChallengeAction and connectTreasuryAction.
  const { challenge, expiresAt } = issueChallenge()
  const challengeId = `chl_${crypto.randomUUID()}`
  storeChallenge(challengeId, challenge, 'treasury', expiresAt, wallet, organizationId)

  const signature = treasury.sign(challengeBytes(challenge)).toString('base64url')

  const row = consumeChallenge(challengeId, 'treasury')
  assert(row, 'challenge could not be consumed')
  assert(row.organizationId === organizationId, 'challenge is bound to a different organization')
  assert(row.walletPublicKey === wallet, 'challenge is bound to a different wallet')
  const check = verifyChallengeSignature(row.challenge, signature, wallet, row.walletPublicKey)
  assert(check.ok, `signature check failed: ${check.ok ? '' : check.reason}`)

  setSettlementWallet({ organizationId, recipient: check.publicKey })
  console.log(`treasury verified: org=${organizationId} recipient=${check.publicKey}`)

  if (!verdict) return

  // The same write and challenge pruning as registerSignerAction.
  db()
    .update(organizations)
    .set({ commitmentSignerUrl: verdict.signerUrl, commitmentSignerTokenEnv: verdict.signerTokenEnv })
    .where(eq(organizations.id, organizationId))
    .run()
  db()
    .update(loginChallenges)
    .set({ consumedAt: Date.now() })
    .where(eq(loginChallenges.organizationId, organizationId))
    .run()
  console.log(`signer registered: org=${organizationId} url=${verdict.signerUrl} tokenEnv=${verdict.signerTokenEnv}`)
}

try {
  main()
} finally {
  closeDatabase()
}
