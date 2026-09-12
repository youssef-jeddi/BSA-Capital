const EXPLORER = 'https://devnet.xrpl.org'
const MARK = { pending: '○', ok: '●', fail: '✕', info: '·' }

export default function Steps({ steps }) {
  if (!steps.length) return null
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={s.state}>
          <span className="mark">{MARK[s.state]}</span>
          <div>
            <b>{s.label}</b>{s.code && <span className="code"> {s.code}</span>}
            {s.hash && (
              <a href={`${EXPLORER}/transactions/${s.hash}`} target="_blank" rel="noreferrer">
                {s.hash.slice(0, 24)}…
              </a>
            )}
            {s.detail && <pre>{s.detail}</pre>}
            {s.error && <span className="err">{s.error}</span>}
          </div>
        </li>
      ))}
    </ol>
  )
}
