'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The paid request lifecycle, as a graph.
 *
 * Layout mirrors a workflow builder: hand-drawn SVG connectors under absolutely
 * positioned HTML nodes, in a fixed logical 1240x460 space that scales down and scrolls
 * horizontally on narrow screens.
 *
 * The nodes describe what PageSure actually does, in the order it does it. A request
 * arrives, preflight policy decides, an allowed request gets a payment challenge, and
 * the payment settles before the upstream response is released. A request that policy
 * blocks or holds never reaches a challenge, so it never moves the payer's balance.
 * That last part is the whole reason the refusal branch exists on this diagram.
 *
 * Why one IntersectionObserver instead of a motion library:
 *
 * The whole diagram is a single object that enters the viewport once. One observer that
 * flips `data-inview` on the root, plus CSS `animation-delay` per element, reproduces
 * `whileInView` with `once: true` for a fraction of the weight, and the connector
 * draw-in is a `stroke-dashoffset` transition that CSS already does well.
 *
 * A scroll-driven `animation-timeline: view()` was rejected here specifically because
 * this diagram lives in a horizontally scrollable container, so the nearest scrollport
 * is the container rather than the page and the timeline would not track the way the
 * page does.
 */

/* ─── Icons ───
 * Hand-drawn 24x24 strokes at 1.75, matching the weight of the typeface. Written out
 * rather than pulled from an icon package: the project has no icon dependency, and six
 * paths are not a reason to add one. Each inherits `currentColor`, so a node's tint
 * token drives the glyph with no extra prop.
 */

function IconRequest(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z" />
      <path d="m21.9 2.1-11 11" />
    </svg>
  )
}

function IconPolicy(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function IconChallenge(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function IconSettled(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function IconRefused(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  )
}

/* ─── Geometry ───
 * Node boxes are 215x118 in a 1240x460 space. All positions below are in that logical
 * space and converted to percentages at render, so the diagram scales as one unit.
 */

const NODE_W = 215
const NODE_H = 118

type Tint = 'neutral' | 'accent' | 'allow' | 'block'

interface NodeDef {
  key: string
  left: number
  top: number
  icon: React.ReactNode
  label: string
  sublabel: string
  tint: Tint
  /** Entry index, which becomes the stagger delay. */
  order: number
}

const NODES: NodeDef[] = [
  {
    key: 'request',
    left: 24,
    top: 190,
    icon: <IconRequest className="size-5" />,
    label: 'Request',
    sublabel: 'GET /v1/search',
    tint: 'neutral',
    order: 0,
  },
  {
    key: 'policy',
    left: 390,
    top: 190,
    icon: <IconPolicy className="size-5" />,
    label: 'Policy',
    sublabel: 'allow, block, or hold',
    tint: 'accent',
    order: 1,
  },
  {
    key: 'challenge',
    left: 756,
    top: 190,
    icon: <IconChallenge className="size-5" />,
    label: 'Challenge',
    sublabel: '402 with payment terms',
    tint: 'accent',
    order: 2,
  },
  {
    key: 'settled',
    left: 1000,
    top: 60,
    icon: <IconSettled className="size-5" />,
    label: 'Settled',
    sublabel: 'response released',
    tint: 'allow',
    order: 3,
  },
  {
    key: 'refused',
    left: 1000,
    top: 330,
    icon: <IconRefused className="size-5" />,
    label: 'Refused',
    sublabel: 'payer charged nothing',
    tint: 'block',
    order: 3,
  },
]

/* Tints resolve through the design system's semantic tokens rather than hardcoded
 * 50-weight backgrounds, so every one of these inverts correctly in dark mode. The
 * accent on Policy and Challenge is the one deliberate use of the brand colour here: it
 * marks the machinery, while green and red are reserved for the two outcomes. */
const TINT: Record<Tint, string> = {
  neutral: 'bg-neutral-soft text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  allow: 'bg-allow-soft text-allow',
  block: 'bg-block-soft text-block',
}

interface EdgeDef {
  d: string
  tone: 'neutral' | 'allow' | 'block' | 'accent'
  label?: { x: number; y: number; text: string }
  order: number
}

/*
 * The two outbound edges from Policy are the interesting part of the diagram.
 *
 * The allow path curves up into Challenge. The refusal path leaves the same port, drops
 * below Challenge entirely, and runs to Refused. Its control points are pushed well
 * under the Challenge box (bottom edge y=308) so the connector never crosses a node and
 * the refusal cannot be misread as a path that passes through the challenge.
 */
const EDGES: EdgeDef[] = [
  { d: 'M239,249 L390,249', tone: 'neutral', order: 0 },
  {
    d: 'M605,230 C 655,206 690,206 756,230',
    tone: 'allow',
    label: { x: 700, y: 186, text: 'allow' },
    order: 1,
  },
  {
    d: 'M605,268 C 700,342 858,389 1000,389',
    tone: 'block',
    label: { x: 700, y: 318, text: 'block or hold' },
    order: 2,
  },
  { d: 'M971,222 C 985,200 985,119 1000,119', tone: 'accent', order: 3 },
]

const STROKE_WIDTH = 1.6
/*
 * `pathLength="1"` rescales the path into a 0..1 space, and that rescaling applies to
 * stroke-dasharray as well as to stroke-dashoffset.
 *
 * That is what lets one dashoffset animation drive all four connectors at the same rate
 * regardless of their real lengths, which range from 109 to 420 units here. The cost is
 * that a literal `6 5` dash pattern is read in the normalized space, where 6 already
 * exceeds the whole path: every connector renders solid and the dashes disappear
 * entirely. These values are therefore in normalized units, chosen to land near an 18
 * cycle rhythm on a mid-length path.
 *
 * Real path lengths still differ, so the dash is ~4 units on the shortest connector and
 * ~14 on the longest. A per-path dash would need getTotalLength() at mount, which is not
 * worth a layout read for a decorative rhythm.
 */
const DASH = '0.03 0.025'

/*
 * Handle dots, one at each end of every connector, the way a builder canvas marks where
 * two shapes meet. Derived from the node geometry rather than typed by hand, so moving a
 * node moves its handles with it.
 *
 * Only the ends that actually carry a connector get a dot. Rendering a dot on all four
 * sides of every node and hiding the unused ones would leave invisible elements in the
 * accessibility tree for no benefit.
 */
const PORTS: Array<{ x: number; y: number; tone: Tint }> = [
  // REQUEST -> POLICY
  { x: 24 + NODE_W, y: 249, tone: 'neutral' },
  { x: 390, y: 249, tone: 'neutral' },
  // POLICY -> CHALLENGE, upper port on both sides
  { x: 390 + NODE_W, y: 230, tone: 'allow' },
  { x: 756, y: 230, tone: 'allow' },
  // POLICY -> REFUSED, lower port on the policy side only
  { x: 390 + NODE_W, y: 268, tone: 'block' },
  { x: 1000, y: 389, tone: 'block' },
  // CHALLENGE -> SETTLED
  { x: 756 + NODE_W, y: 222, tone: 'accent' },
  { x: 1000, y: 119, tone: 'accent' },
]

export function WorkflowDiagram() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root || inView) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      // Fire slightly before the diagram is fully on screen so the draw-in is already
      // running by the time the reader's eye arrives at the middle of it.
      { rootMargin: '0px 0px -18% 0px', threshold: 0.05 },
    )
    observer.observe(root)
    return () => observer.disconnect()
  }, [inView])

  return (
    <div
      ref={rootRef}
      data-inview={inView ? 'true' : 'false'}
      className="flow-diagram overflow-x-auto rounded-card border border-line bg-surface p-2 sm:p-5"
    >
      <div className="relative mx-auto aspect-[1240/460] w-full min-w-[880px]">
        {/* Connector layer */}
        <svg viewBox="0 0 1240 460" className="absolute inset-0 size-full" fill="none" aria-hidden>
          <defs>
            {(['neutral', 'allow', 'block', 'accent'] as const).map((tone) => (
              <marker
                key={tone}
                id={`arrow-${tone}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={TINT[tone].split(' ')[1]} />
              </marker>
            ))}
          </defs>

          {EDGES.map((edge) => (
            <path
              key={edge.d}
              d={edge.d}
              pathLength={1}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={DASH}
              markerEnd={`url(#arrow-${edge.tone})`}
              className={`flow-edge stroke-${edge.tone}`}
              style={{ animationDelay: `${150 + edge.order * 160}ms` }}
            />
          ))}

          {EDGES.map((edge) =>
            edge.label ? (
              <text
                key={edge.label.text}
                x={edge.label.x}
                y={edge.label.y}
                textAnchor="middle"
                fontSize="13"
                fontWeight={600}
                fontFamily="inherit"
                className={`flow-label fill-${edge.tone}`}
                style={{ animationDelay: `${500 + edge.order * 160}ms` }}
              >
                {edge.label.text}
              </text>
            ) : null,
          )}
        </svg>

        {/* Handle dots */}
        {PORTS.map((port) => (
          <span
            key={`${port.x}-${port.y}`}
            aria-hidden
            className={`flow-port pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface ${TINT[port.tone].split(' ')[1]}`}
            style={{ left: `${(port.x / 1240) * 100}%`, top: `${(port.y / 460) * 100}%` }}
          />
        ))}

        {/* Nodes */}
        {NODES.map((node) => (
          <div
            key={node.key}
            className="flow-node absolute flex flex-col items-center justify-center gap-1.5 rounded-card border border-line bg-surface px-3 text-center"
            style={{
              left: `${(node.left / 1240) * 100}%`,
              top: `${(node.top / 460) * 100}%`,
              width: `${(NODE_W / 1240) * 100}%`,
              height: `${(NODE_H / 460) * 100}%`,
              animationDelay: `${100 + node.order * 160}ms`,
            }}
          >
            <span className={`flex size-10 items-center justify-center rounded-control ${TINT[node.tint]}`}>
              {node.icon}
            </span>
            <p className="text-[13px] font-medium text-ink">{node.label}</p>
            <p className="text-[11px] text-ink-3">{node.sublabel}</p>
          </div>
        ))}
      </div>
    </div>
  )
}