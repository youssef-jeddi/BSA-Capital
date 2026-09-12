/**
 * What a first-time visitor sees.
 *
 * The app used to open on a bare "Connect wallet" card asking for a WalletConnect
 * project id. Nothing said what the platform was, so anyone who did not already
 * know the project saw a debug console.
 */
const PHASES = [
  { name: 'Subscription', note: 'Investors deposit and receive shares. Lending is blocked.' },
  { name: 'Investment', note: 'Capital is lent out. Deposits and withdrawals are blocked.' },
  { name: 'Redemption', note: 'Loans wind down and investors withdraw, with interest.' },
]

const FEATURES = [
  {
    title: 'Compliance the platform runs',
    body: 'A fund picks the regulatory zones it accepts. Investors hold a zone credential, and the '
      + 'ledger refuses anyone else — no application-layer check involved.',
  },
  {
    title: 'Liquidity before maturity',
    body: 'A close-ended fund locks capital for its whole term. Holders who need out early sell '
      + 'their position to another eligible investor at a discount to net asset value.',
  },
  {
    title: 'Curated fund-of-funds',
    body: 'A curator spreads one deposit across several funds and takes first loss, so depositors '
      + 'hold a single diversified position instead of picking managers themselves.',
  },
]

export default function Landing({ children }) {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Private credit on the XRP Ledger</p>
        <h2>Fixed-term lending funds that anyone eligible can join, and leave early.</h2>
        <p className="hero-sub">
          Fund managers raise capital into a close-ended vault, lend it to vetted borrowers, and
          return it with interest. Every rule below is enforced by the ledger, not by us.
        </p>
      </section>

      <section className="lifecycle" aria-label="Fund lifecycle">
        {PHASES.map((p, i) => (
          <div key={p.name} className="lifecycle-step">
            <span className="lifecycle-index">{i + 1}</span>
            <b>{p.name}</b>
            <span>{p.note}</span>
          </div>
        ))}
      </section>

      {children}

      <section className="features">
        {FEATURES.map((f) => (
          <article key={f.title}>
            <b>{f.title}</b>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <p className="footnote">
        Running on the public XRP Ledger Devnet. Test funds only — nothing here has real value.
      </p>
    </>
  )
}
