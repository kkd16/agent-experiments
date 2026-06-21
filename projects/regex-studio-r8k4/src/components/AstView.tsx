import type { RegexNode } from '../engine/ast';

export function AstView({ ast }: { ast: RegexNode | null }) {
  if (!ast) return <div className="placeholder">No AST — fix the pattern first.</div>;
  return (
    <div className="ast">
      <AstNode node={ast} />
    </div>
  );
}

interface NodeMeta {
  kind: string;
  detail?: string;
  children: RegexNode[];
  cls: string;
}

function describe(node: RegexNode): NodeMeta {
  switch (node.type) {
    case 'empty':
      return { kind: 'ε', detail: 'empty', children: [], cls: 'ast-empty' };
    case 'char':
      return { kind: node.raw, detail: node.set.label(), children: [], cls: 'ast-char' };
    case 'concat':
      return { kind: 'concat', detail: `${node.parts.length} parts`, children: node.parts, cls: 'ast-op' };
    case 'alt':
      return { kind: 'alternation', detail: `${node.options.length} options`, children: node.options, cls: 'ast-alt' };
    case 'star':
      return { kind: 'star', detail: node.lazy ? '*? (lazy)' : '* (0+)', children: [node.node], cls: 'ast-quant' };
    case 'plus':
      return { kind: 'plus', detail: node.lazy ? '+? (lazy)' : '+ (1+)', children: [node.node], cls: 'ast-quant' };
    case 'opt':
      return { kind: 'optional', detail: node.lazy ? '?? (lazy)' : '? (0 or 1)', children: [node.node], cls: 'ast-quant' };
    case 'repeat':
      return {
        kind: 'repeat',
        detail: `{${node.min},${node.max ?? '∞'}}${node.lazy ? ' lazy' : ''}`,
        children: [node.node],
        cls: 'ast-quant',
      };
    case 'group':
      return { kind: `group #${node.index}`, detail: 'capturing', children: [node.node], cls: 'ast-group' };
    case 'anchor':
      return {
        kind: node.at === 'start' ? '^' : '$',
        detail: node.at === 'start' ? 'start anchor' : 'end anchor',
        children: [],
        cls: 'ast-assert',
      };
    case 'boundary':
      return {
        kind: node.negate ? '\\B' : '\\b',
        detail: node.negate ? 'non-boundary' : 'word boundary',
        children: [],
        cls: 'ast-assert',
      };
    case 'backref':
      return { kind: `\\${node.index}`, detail: `backref → group #${node.index}`, children: [], cls: 'ast-assert' };
    case 'look': {
      const sym = `(?${node.dir === 'behind' ? '<' : ''}${node.negate ? '!' : '='}…)`;
      const word = `${node.negate ? 'negative ' : ''}look${node.dir}`;
      return { kind: sym, detail: word, children: [node.node], cls: 'ast-look' };
    }
    case 'intersect':
      return { kind: '&', detail: `intersection of ${node.parts.length}`, children: node.parts, cls: 'ast-bool' };
    case 'complement':
      return { kind: '~', detail: 'complement (Σ∗ ∖ A)', children: [node.node], cls: 'ast-bool' };
  }
}

function AstNode({ node }: { node: RegexNode }) {
  const meta = describe(node);
  return (
    <div className="ast-row">
      <div className={`ast-node ${meta.cls}`}>
        <span className="ast-kind">{meta.kind}</span>
        {meta.detail && <span className="ast-detail">{meta.detail}</span>}
      </div>
      {meta.children.length > 0 && (
        <div className="ast-children">
          {meta.children.map((c, i) => (
            <AstNode key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}
