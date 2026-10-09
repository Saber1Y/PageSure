import { serviceRollups } from '@/lib/metering/aggregates'
import { requireUserPage } from '@/lib/auth/session'
import { PlaygroundClient } from '@/components/dashboard/playground-client'
import { Brand } from '@/components/ui/brand'
import { formatAmount } from '@/lib/money'
import { USDC_SAC_TESTNET } from '@stellar/mpp'

export const dynamic = 'force-dynamic'

export default async function PlaygroundPage() {
  const user = await requireUserPage()
  const services = serviceRollups(user.organizationId).filter((s) => s.status === 'live')
  const chargeServices = services.filter((s) => s.mode === 'charge')
  const channelServices = services.filter((s) => s.mode === 'channel')

  return (
    <div className="min-h-[100dvh]">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <Brand href="/" suffix="Playground" />
          <a href="/overview" className="inline-flex items-center rounded-control px-2 py-1 text-[13px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
            Provider console
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <div className="max-w-[68ch]">
          <h1 className="text-[26px] leading-tight font-semibold tracking-tight">
            Agent playground
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Run a request as an agent would. Charge mode signs a Soroban transfer per
            request; session mode opens an MPP channel, sends off-chain signed commitments,
            and settles once on chain. The waterfall below is built from the SDK&apos;s own
            progress events, not an animation.
          </p>
          <p className="mono mt-2 text-[11px] break-all text-ink-4">
            asset {USDC_SAC_TESTNET}
          </p>
        </div>

        <div className="mt-8">
          <PlaygroundClient
            services={chargeServices.map((s) => ({
              slug: s.slug,
              name: s.name,
              description: s.description,
              price: formatAmount(s.priceBase, s.decimals),
              assetCode: s.assetCode,
            }))}
            channelServices={channelServices.map((s) => ({
              slug: s.slug,
              name: s.name,
              description: s.description,
              price: formatAmount(s.priceBase, s.decimals),
              assetCode: s.assetCode,
              decimals: s.decimals,
            }))}
          />
        </div>
      </main>
    </div>
  )
}