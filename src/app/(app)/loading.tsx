/**
 * Console loading state. Skeletons mirror the overview layout: a metric band, then two
 * panels. Matching the real shape keeps the transition to loaded content from jumping.
 */
export default function ConsoleLoading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div>
        <span className="skeleton block h-6 w-28 rounded" />
        <span className="skeleton mt-2 block h-4 w-72 rounded" />
      </div>

      <div className="rounded-card border border-line bg-surface p-5">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <span className="skeleton block h-3 w-16 rounded" />
              <span className="skeleton block h-6 w-24 rounded" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="skeleton block h-3 w-3 rounded-full" />
                <span className="skeleton block h-3 flex-1 rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <span className="skeleton block h-3 w-20 rounded" />
                <span className="skeleton block h-4 w-28 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}