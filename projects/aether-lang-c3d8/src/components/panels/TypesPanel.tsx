import type { BindingType } from '../../lang/pipeline.ts'

interface Props {
  programType: string | null
  bindingTypes: BindingType[]
}

export default function TypesPanel({ programType, bindingTypes }: Props) {
  if (!programType) return <div className="panel-empty">No types — fix the error first.</div>
  return (
    <div className="types-panel">
      <p className="panel-note">
        Types are inferred by <strong>Algorithm W</strong> (Hindley–Milner): no annotations needed.
        <code>let</code>-bound values are generalised, so <code>fn x -&gt; x</code> becomes{' '}
        <code>∀ a. a -&gt; a</code> and can be used at many types.
      </p>

      <div className="type-result">
        <span className="type-label">program</span>
        <code className="type-sig big">{programType}</code>
      </div>

      {bindingTypes.length > 0 && (
        <table className="type-table">
          <tbody>
            {bindingTypes.map((b) => (
              <tr key={b.name}>
                <td className="type-name">{b.name}</td>
                <td className="type-colon">:</td>
                <td className="type-sig">
                  <code>{b.type}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
