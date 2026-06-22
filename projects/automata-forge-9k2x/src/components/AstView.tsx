import type { Ast, CharPred, ClassItem } from '../engine/types'
import { showChar } from '../engine/types'
import './AstView.css'

function classItem(it: ClassItem): string {
  return it.kind === 'char' ? showChar(it.char) : `${showChar(it.lo)}-${showChar(it.hi)}`
}

function describePred(p: CharPred): string {
  if (p.kind === 'lit') return `'${showChar(p.char)}'`
  if (p.kind === 'any') return '. (any)'
  return `[${p.neg ? '^' : ''}${p.items.map(classItem).join('')}]`
}

const META: Record<Ast['type'], { label: string; cls: string }> = {
  epsilon: { label: 'ε', cls: 'eps' },
  char: { label: 'char', cls: 'char' },
  concat: { label: 'concat ·', cls: 'concat' },
  alt: { label: 'alt |', cls: 'alt' },
  star: { label: 'star *', cls: 'rep' },
  plus: { label: 'plus +', cls: 'rep' },
  opt: { label: 'opt ?', cls: 'rep' },
}

function Node({ node }: { node: Ast }) {
  const meta = META[node.type]
  let detail: string | null = null
  let children: Ast[] = []
  switch (node.type) {
    case 'char':
      detail = describePred(node.pred)
      break
    case 'concat':
      children = node.parts
      break
    case 'alt':
      children = node.options
      break
    case 'star':
    case 'plus':
    case 'opt':
      children = [node.node]
      break
    case 'epsilon':
      break
  }
  return (
    <li>
      <span className={`ast-node ${meta.cls}`}>
        <span className="ast-kind">{meta.label}</span>
        {detail && <span className="ast-detail">{detail}</span>}
      </span>
      {children.length > 0 && (
        <ul>
          {children.map((c, i) => (
            <Node key={i} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function AstView({ ast }: { ast: Ast }) {
  return (
    <div className="ast-view">
      <ul className="ast-root">
        <Node node={ast} />
      </ul>
    </div>
  )
}
