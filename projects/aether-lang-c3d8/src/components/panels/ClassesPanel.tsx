import { useMemo } from 'react'
import type { Expr } from '../../lang/ast.ts'
import { typeExprToString, unparse } from '../../lang/unparse.ts'

interface Props {
  /** the user's surface AST (with `class` / `instance` declarations) */
  ast: Expr | null
  /** the elaborated, dictionary-passed core AST */
  coreAst: Expr | null
}

interface ClassRow {
  name: string
  param: string
  methods: { name: string; sig: string; hasDefault: boolean }[]
}

interface InstanceRow {
  cls: string
  head: string
  context: string[]
  methods: string[]
}

// Walk the declaration spine of a program collecting class & instance decls.
function collect(ast: Expr | null): { classes: ClassRow[]; instances: InstanceRow[] } {
  const classes: ClassRow[] = []
  const instances: InstanceRow[] = []
  let node = ast
  while (node) {
    if (node.kind === 'classdecl') {
      classes.push({
        name: node.name,
        param: node.param,
        methods: node.methods.map((m) => ({
          name: m.name,
          sig: typeExprToString(m.type),
          hasDefault: m.default !== undefined,
        })),
      })
      node = node.body
    } else if (node.kind === 'instancedecl') {
      instances.push({
        cls: node.cls,
        head: typeExprToString(node.head),
        context: node.context.map((c) => `${c.cls} ${c.param}`),
        methods: node.methods.map((m) => m.name),
      })
      node = node.body
    } else if (node.kind === 'let' || node.kind === 'typedecl') {
      node = node.body
    } else if (node.kind === 'letrec') {
      node = node.body
    } else {
      break
    }
  }
  return { classes, instances }
}

export default function ClassesPanel({ ast, coreAst }: Props) {
  const { classes, instances } = useMemo(() => collect(ast), [ast])
  const core = useMemo(() => (coreAst ? unparse(coreAst) : null), [coreAst])

  if (!ast) return <div className="panel-empty">No classes — fix the error first.</div>

  if (classes.length === 0 && instances.length === 0) {
    return (
      <div className="classes-panel">
        <p className="panel-note">
          This program declares no type classes. Add a <code>class C a where m : …</code> and an{' '}
          <code>instance C T where m = …</code> to overload a function across types. Aether resolves
          each constraint and compiles classes to <strong>dictionary passing</strong> — visible in
          the elaborated core below.
        </p>
      </div>
    )
  }

  return (
    <div className="classes-panel">
      <p className="panel-note">
        Type classes give <strong>principled overloading</strong>. Aether infers a qualified type
        like <code>∀a. Disp a =&gt; a -&gt; String</code>, resolves each constraint to an instance,
        and elaborates to <strong>dictionary passing</strong>: instances become records, constrained
        functions take dictionary arguments, and method calls become field accesses.
      </p>

      {classes.length > 0 && (
        <div className="cls-section">
          <h4 className="cls-head">classes</h4>
          {classes.map((c) => (
            <div className="cls-card" key={c.name}>
              <div className="cls-title">
                <span className="cls-kw">class</span> {c.name} {c.param}
              </div>
              <table className="cls-methods">
                <tbody>
                  {c.methods.map((m) => (
                    <tr key={m.name}>
                      <td className="cls-mname">{m.name}</td>
                      <td className="cls-colon">:</td>
                      <td className="cls-sig">
                        <code>{m.sig}</code>
                        {m.hasDefault && <span className="cls-default"> · has default</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {instances.length > 0 && (
        <div className="cls-section">
          <h4 className="cls-head">instances</h4>
          {instances.map((i, k) => (
            <div className="inst-card" key={k}>
              <span className="cls-kw">instance</span>{' '}
              {i.context.length > 0 && <span className="inst-ctx">{i.context.join(', ')} ⇒ </span>}
              <span className="inst-headcls">{i.cls}</span> <code>{i.head}</code>
              <span className="inst-methods"> — {i.methods.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {core && (
        <div className="cls-section">
          <h4 className="cls-head">elaborated core — dictionaries made visible</h4>
          <p className="panel-note tiny">
            The same program after dictionary-passing elaboration. Both backends compile{' '}
            <em>this</em>; the surface <code>class</code>/<code>instance</code> forms are gone.
          </p>
          <pre className="cls-core">{core}</pre>
        </div>
      )}
    </div>
  )
}
