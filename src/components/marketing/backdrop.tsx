/**
 * Page backdrop.
 *
 * Depth on a light canvas comes from layers, not from a darker fill. Three fixed,
 * non-interactive layers sit behind the content:
 *
 *  1. a warm accent bloom from the top of the viewport, which is where the eye lands
 *  2. a fine engineering grid, radially masked so it is densest under the hero and gone
 *     by the time the reader reaches the ledger
 *  3. two slow drifting accent orbs, which keep the lower page from going flat
 *
 * All three are decorative, so they are `aria-hidden` and `pointer-events-none`. They are
 * also `fixed` and `inset-0`, which means they cost one composited layer regardless of
 * how far the page scrolls.
 *
 * The grid is intentionally a grid rather than a dot texture. A dot field at this
 * contrast reads as noise on a warm ground; a 56px grid reads as drafting paper, which is
 * the right register for infrastructure.
 *
 * Every colour resolves through a token, so the whole stack inverts with the theme
 * instead of needing a dark-mode variant of this component.
 *
 * Stacking: this sits at z-0, and the page content is lifted to z-10 by its own wrapper.
 * A negative z-index looks like the obvious way to push something behind content, but
 * body and html both paint an opaque canvas colour here, so anything below z-0 disappears
 * behind the page background rather than behind the content. The layers were verified by
 * sampling rendered pixels, not just by confirming the nodes existed in the DOM.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* Accent bloom, anchored above the fold so the hero sits in it */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_85%_55%_at_50%_-8%,var(--backdrop-bloom)_0%,transparent_62%)]" />

      {/* Drafting grid, masked to the upper page */}
      <div className="absolute inset-0 bg-[linear-gradient(var(--backdrop-grid)_1px,transparent_1px),linear-gradient(90deg,var(--backdrop-grid)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_80%_60%_at_50%_0%,black_25%,transparent_78%)]" />

      {/* Drifting orbs. Slower than anything on the page and heavily blurred, so they
          register as a change in light rather than as moving objects. */}
      <div className="backdrop-orb absolute -top-40 left-[4%] size-[30rem] rounded-full bg-[radial-gradient(circle,var(--backdrop-orb)_0%,transparent_68%)] blur-3xl" />
      <div className="backdrop-orb backdrop-orb-late absolute top-[38%] -right-32 size-[26rem] rounded-full bg-[radial-gradient(circle,var(--backdrop-orb)_0%,transparent_68%)] blur-3xl" />
    </div>
  )
}