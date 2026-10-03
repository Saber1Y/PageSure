import { Badge, Card, CardHeader, Dot, EmptyState, KeyValue, short } from '@/components/ui/primitives'
import { settlementRows } from '@/lib/metering/aggregates'
import { formatAmount } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * Settlements. This is where PageSure proves it is actually connected to Stellar: every
 * row is a confirmed transaction hash with an explorer link.
 */
export default function SettlementsPage() {
  const rows = settlementRows(100)

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-[22px] font-medium tracking-tight">Settlements</h1>
        <p className="mt-1 max-w-[65ch] text-[14px] leading-relaxed text-ink-3">
          Every row is a real Stellar transaction. A charge settles once per request; a
          session settles once for the whole channel.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No settlements yet"
            body="Once a request is paid, or a session is closed and settled, the transaction appears here with an explorer link."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="label-xs px-5 py-3">Kind</th>
                  <th className="label-xs px-3 py-3">Payer</th>
                  <th className="label-xs px-3 py-3 text-right">Amount</th>
                  <th className="label-xs px-3 py-3 text-right">Calls</th>
                  <th className="label-xs px-3 py-3">Transaction</th>
                  <th className="label-xs px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-surface-2">
                    <td className="px-5 py-3">
                      <Badge tone={row.kind === 'session' ? 'pending' : 'neutral'}>{row.kind}</Badge>
                    </td>
                    <td className="mono px-3 py-3 text-[12px] text-ink-2">
                      {short(row.payer, 8, 4)}
                    </td>
                    <td className="mono px-3 py-3 text-right text-[13px] text-ink">
                      {formatAmount(row.amountBase, row.decimals)}{' '}
                      <span className="text-[11px] text-ink-3">{row.assetCode}</span>
                    </td>
                    <td className="mono px-3 py-3 text-right text-[13px] text-ink-2">
                      {row.requestCount}
                    </td>
                    <td className="px-3 py-3">
                      {row.explorerUrl ? (
                        <a
                          href={row.explorerUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mono text-[12px] text-accent hover:underline"
                        >
                          {short(row.txHash, 10, 6)}
                        </a>
                      ) : (
                        <span className="mono text-[12px] text-ink-4">{short(row.txHash, 10, 6)}</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-2">
                        <Dot tone={row.status === 'confirmed' ? 'allow' : row.status === 'failed' ? 'block' : 'review'} />
                        <span className="text-[12px] text-ink-2">{row.status}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rows[0] ? (
        <Card>
          <CardHeader title="Most recent settlement" hint="On-chain detail" />
          <div className="px-5 pb-5">
            <KeyValue k="Amount" v={`${formatAmount(rows[0].amountBase, rows[0].decimals)} ${rows[0].assetCode}`} mono />
            <KeyValue k="Payer" v={rows[0].payer} mono />
            <KeyValue k="Recipient" v={rows[0].recipient} mono />
            <KeyValue k="Network" v={rows[0].network} mono />
            <KeyValue k="Transaction" v={rows[0].txHash} mono />
            <KeyValue k="Status" v={rows[0].status} mono />
          </div>
        </Card>
      ) : null}
    </div>
  )
}