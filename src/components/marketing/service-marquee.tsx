'use client'

import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Marquee of the live service names on this deployment.
 *
 * Why this measures instead of hardcoding a repeat count:
 *
 * A seamless marquee requires one repeated unit to be at least as wide as the container
 * that clips it. Unit width is a function of three things that are all unknown at render
 * time: how many services are live, how long their names render at the current font, and
 * how wide the viewport is. Any count fixed in JSX or CSS is correct for one combination
 * of those and visibly broken for another.
 *
 * Concretely, with three live services the measured one-copy width was 411px inside a
 * 1330px container at 1440px. A track that translates one copy per loop therefore runs
 * out of names and scrolls a ~509px hole across the strip.
 *
 * So: measure a single repetition, repeat it until one unit fills the container, render
 * exactly two units, and shift by 50%. Two units make the loop point land on an
 * identical copy, and the shift of one unit is what keeps the seam invisible.
 *
 * Until the fill is known the names render once and statically. Animating a track that
 * is known to be under-filled is the precise failure described above, so the component
 * shows its content immediately and only starts moving once the loop is closed.
 */
export function ServiceMarquee({ names }: { names: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const repetitionRef = useRef<HTMLSpanElement>(null)
  const [copies, setCopies] = useState(1)
  const [filled, setFilled] = useState(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    const repetition = repetitionRef.current
    if (!container || !repetition) return

    const measure = () => {
      const unit = repetition.getBoundingClientRect().width
      const available = container.getBoundingClientRect().width
      if (unit <= 0 || available <= 0) return
      setCopies(Math.max(1, Math.ceil(available / unit)))
      setFilled(true)
    }

    measure()

    // A resize changes how many repetitions fit, so the fill has to be recomputed rather
    // than baked once. Without this, rotating a phone or crossing the md breakpoint would
    // leave the track short and reopen the gap.
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const repetition = (index: number) => (
    <span
      // Only the first repetition is meaningful to a screen reader; the rest exist to
      // make the loop seamless and would otherwise be announced as duplicates.
      aria-hidden={index > 0 ? true : undefined}
      className="flex shrink-0 items-center gap-10 pr-10"
    >
      {names.map((name) => (
        <span key={name} className="shrink-0 text-[14px] whitespace-nowrap text-ink-3">
          {name}
        </span>
      ))}
    </span>
  )

  return (
    <div ref={containerRef} className="mask-edges relative flex-1 overflow-hidden">
      <ul className={`flex w-max items-center${filled ? ' animate-marquee' : ''}`}>
        {[0, 1].map((unit) => (
          <li key={unit} className="flex shrink-0 items-center">
            {Array.from({ length: copies }, (_, index) => (
              <span key={index} ref={unit === 0 && index === 0 ? repetitionRef : undefined}>
                {repetition(unit === 0 ? index : 1 + index)}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}