/**
 * A close-ended fund's whole term, drawn to scale.
 *
 * Three segments sized by real duration — subscription, investment, redemption —
 * with the elapsed part shaded out behind a "now" marker. A phase badge tells you
 * where the fund is; this tells you how much of the term is already gone, which
 * is the thing an investor in a locked position actually wants to know.
 */

const pct = (n) => `${Math.max(0, Math.min(100, n)).toFixed(2)}%`

/** Redemption has no ledger end date, so the tail is drawn as a fixed slice. */
const REDEMPTION_SHARE = 0.08

/**
 * @param sub   subscription close, ms
 * @param red   redemption open, ms
 * @param start when the fund opened, ms — falls back to a term-proportional guess
 */
export function railGeometry({ start, sub, red, nowMs }) {
  if (!sub || !red || red <= sub) return null
  // Without a recorded creation date, assume the subscription window ran for a
  // tenth of the term. It only affects the width of the first segment.
  const opened = start && start < sub ? start : sub - (red - sub) / 9
  const span = red - opened
  const tail = span * REDEMPTION_SHARE
  const total = span + tail
  return {
    subW: pct(((sub - opened) / total) * 100),
    redW: pct((tail / total) * 100),
    now: pct(((nowMs - opened) / total) * 100),
    elapsed: nowMs >= opened && nowMs <= red + tail,
  }
}

export default function LifecycleRail({ start, sub, red, nowMs, big, caption, legend }) {
  const g = railGeometry({ start, sub, red, nowMs })
  if (!g) return null

  const phase = nowMs < sub ? 'sub' : nowMs < red ? 'inv' : 'red'

  return (
    <>
      <div className={big ? 'rail big' : 'rail'}>
        <div className="rail-bars">
          <i className="rail-sub" style={{ flex: `0 0 ${g.subW}` }} />
          <i className="rail-inv" style={{ flex: 1 }} />
          <i className="rail-red" style={{ flex: `0 0 ${g.redW}` }} />
        </div>
        {/* Shades the part of the term that has already run. */}
        <div className="rail-now" style={{ left: g.now }} />
        {big && caption && (
          <span className={`rail-caption on-${phase}`}
                style={phase === 'sub' ? undefined : { left: `calc(${g.subW} + 12px)` }}>
            {caption}
          </span>
        )}
        {big && <div className="rail-nowlabel" style={{ left: g.now }}>now</div>}
      </div>
      {legend && (
        <div className="rail-legend">
          {legend.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </>
  )
}
