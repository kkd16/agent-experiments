import type { Token } from '../../lang/lexer.ts'

interface Props {
  tokens: Token[] | null
}

export default function TokensPanel({ tokens }: Props) {
  if (!tokens) return <div className="panel-empty">No tokens — fix the error first.</div>
  const shown = tokens.filter((t) => t.kind !== 'eof')
  return (
    <div className="tokens-panel">
      <p className="panel-note">
        The lexer scans the source into {shown.length} tokens, each tagged with its kind and exact
        source position.
      </p>
      <div className="token-flow">
        {shown.map((t, i) => (
          <span key={i} className={`tok tok-${t.kind}`} title={`${t.kind} @ ${t.span.line}:${t.span.col}`}>
            <span className="tok-kind">{t.kind}</span>
            <span className="tok-val">{t.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
