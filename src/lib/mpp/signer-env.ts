/** Build the provider signer's inherited environment without payer commitment material. */
export function providerSignerEnvironment(
  source: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== 'AGENT_COMMITMENT_SEED'),
  ) as NodeJS.ProcessEnv
}
