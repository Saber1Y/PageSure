import { Badge, Card, Dot, KeyValue, short } from '@/components/ui/primitives'
import { policiesWithUsage } from '@/lib/policy/read-model'

export const dynamic = 'force-dynamic'

/**
 * A provider-defined access policy engine. It is not, and is not presented as, a
 * complete regulatory compliance platform.
 */
export default function PoliciesPage() {
  const rows = policiesWithUsage()

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">Policies</h1>
        <p className="mt-1 max-w-[65ch] text-[14px] leading-relaxed text-ink-3">
          A provider-defined access policy engine. Evaluation is ordered and every check
          is recorded, so any decision can be explained after the fact.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card>
          <div className="px-5 py-10 text-[13px] text-ink-3">
            No policies yet. Attach a policy to a service to control who can reach it.
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {rows.map(({ policy, usage }) => (
            <Card key={policy.id}>
              <div className="flex flex-col gap-5 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[16px] font-medium tracking-tight">{policy.name}</h2>
                    <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-ink-3">
                      {policy.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Dot tone={policy.active ? 'allow' : 'neutral'} />
                    <Badge tone={policy.active ? 'allow' : 'neutral'}>
                      {policy.active ? 'active' : 'disabled'}
                    </Badge>
                  </div>
                </div>

                <div className="grid gap-x-8 gap-y-1 border-t border-line pt-4 sm:grid-cols-2">
                  <KeyValue
                    k="Unknown wallet"
                    v={
                      <Badge
                        tone={
                          policy.unknownAction === 'allow'
                            ? 'allow'
                            : policy.unknownAction === 'review'
                              ? 'review'
                              : 'block'
                        }
                      >
                        {policy.unknownAction}
                      </Badge>
                    }
                  />
                  <KeyValue k="Per-request cap" v={policy.maxAmountPerRequestBase ?? 'none'} mono />
                  <KeyValue k="Daily wallet cap" v={policy.dailyCapPerWalletBase ?? 'none'} mono />
                  <KeyValue k="Ungranted spend cap" v={policy.ungrantedSpendCapBase ?? 'none'} mono />
                  <KeyValue
                    k="Rate limit"
                    v={policy.rateLimitPerMin ? `${policy.rateLimitPerMin}/min` : 'none'}
                    mono
                  />
                  <KeyValue k="Allowed assets" v={usage.assets.length} mono />
                </div>

                <div className="grid gap-6 border-t border-line pt-4 sm:grid-cols-3">
                  <div>
                    <span className="label-xs">Allowlist</span>
                    <p className="mono mt-2 text-[13px] text-ink">
                      {usage.allowlist.length} wallets
                    </p>
                    {usage.allowlist.slice(0, 3).map((row) => (
                      <p key={row.id} className="mono mt-1 text-[11px] text-ink-3">
                        {short(row.wallet, 8, 4)}
                      </p>
                    ))}
                  </div>
                  <div>
                    <span className="label-xs">Denylist</span>
                    <p className="mono mt-2 text-[13px] text-ink">
                      {usage.denylist.length} wallets
                    </p>
                    {usage.denylist.slice(0, 3).map((row) => (
                      <p key={row.id} className="mono mt-1 text-[11px] text-ink-3">
                        {short(row.wallet, 8, 4)}
                      </p>
                    ))}
                  </div>
                  <div>
                    <span className="label-xs">Active grants</span>
                    <p className="mono mt-2 text-[13px] text-ink">{usage.activeGrants}</p>
                    <p className="mt-1 text-[11px] leading-snug text-ink-3">
                      Scoped, expiring, never written to the allowlist.
                    </p>
                  </div>
                </div>

                <div className="border-t border-line pt-4">
                  <span className="label-xs">Bound services</span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {usage.services.length === 0 ? (
                      <span className="text-[13px] text-ink-3">None</span>
                    ) : (
                      usage.services.map((service) => (
                        <a
                          key={service.id}
                          href={`/services/${service.id}`}
                          className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                        >
                          {service.name}
                        </a>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}