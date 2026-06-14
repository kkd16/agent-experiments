import { useMemo, useState } from 'react'
import type { Expr } from '../../lang/ast.ts'
import type { InferResult } from '../../lang/infer.ts'
import { buildDerivation, countSteps } from '../../lang/derivation.ts'
import type { DerivNode } from '../../lang/derivation.ts'

interface Props {
  ast: Expr | null
  typeResult: InferResult | null
}

export default function DerivationPanel({ ast, typeResult }: Props) {
  const tree = useMemo(
    () => (ast && typeResult ? buildDerivation(ast, typeResult.nodeTypes) : null),
    [ast, typeResult],
  )

  if (!tree) return <div className="panel-empty">No derivation — fix the error first.</div>

  return (
    <div className="deriv-panel">
      <p className="panel-note">
        The Hindley–Milner <em>proof tree</em>, reconstructed from inference. Each step applies one
        typing rule — its premises (the sub-derivations above it) justify its conclusion{' '}
        <code>expr : τ</code>. {countSteps(tree).toLocaleString()} steps in all.
      </p>
      <div className="deriv-root">
        <DerivView node={tree} depth={0} />
      </div>
    </div>
  )
}

function DerivView({ node, depth }: { node: DerivNode; depth: number }) {
  const [open, setOpen] = useState(depth < 3)
  const hasPremises = node.premises.length > 0
  return (
    <div className="deriv-node">
      <div className="deriv-conc">
        {hasPremises ? (
          <button className="deriv-toggle" onClick={() => setOpen((o) => !o)} aria-label="toggle">
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="deriv-toggle leaf">·</span>
        )}
        <span className="deriv-rule">{node.rule}</span>
        <code className="deriv-expr">{node.exprText}</code>
        <span className="deriv-colon">:</span>
        <code className="deriv-type">{node.type}</code>
      </div>
      {hasPremises && open && (
        <div className="deriv-premises">
          {node.premises.map((p, i) => (
            <DerivView key={i} node={p} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
