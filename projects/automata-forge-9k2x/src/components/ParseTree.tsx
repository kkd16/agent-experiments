import type { ParseNode } from '../engine/cfg/earley'
import { showChar } from '../engine/types'
import './ParseTree.css'

function Node({ node }: { node: ParseNode }) {
  if (node.terminal) {
    return (
      <li>
        <span className="pt-node term">{showChar(node.symbol)}</span>
      </li>
    )
  }
  const children = node.children && node.children.length > 0 ? node.children : null
  return (
    <li>
      <span className="pt-node nt">{node.symbol}</span>
      <ul>
        {children ? (
          children.map((c, i) => <Node key={i} node={c} />)
        ) : (
          <li>
            <span className="pt-node eps">ε</span>
          </li>
        )}
      </ul>
    </li>
  )
}

/** A hand-rendered derivation tree. Nonterminals branch; terminals and ε are leaves. */
export default function ParseTree({ tree }: { tree: ParseNode }) {
  return (
    <div className="pt-view">
      <ul className="pt-root">
        <Node node={tree} />
      </ul>
    </div>
  )
}
