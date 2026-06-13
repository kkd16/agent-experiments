import { useMemo } from 'react'
import type { FnProto } from '../../lang/bytecode.ts'
import { allProtos, disassemble } from '../../lang/bytecode.ts'

interface Props {
  proto: FnProto | null
}

export default function BytecodePanel({ proto }: Props) {
  const protos = useMemo(() => (proto ? allProtos(proto) : []), [proto])
  if (!proto) return <div className="panel-empty">No bytecode — fix the error first.</div>

  return (
    <div className="bytecode-panel">
      <p className="panel-note">
        Each function compiles to its own proto. Free variables are captured as <em>upvalues</em>;
        the prelude (map, filter, fold…) is compiled in alongside your code.
      </p>
      {protos.map((p, i) => (
        <div className="proto" key={i}>
          <div className="proto-head">
            <span className="proto-name">{p.name}</span>
            <span className="proto-meta">
              {p.numParams} param{p.numParams === 1 ? '' : 's'}
              {p.upvalues.length > 0 && (
                <> · upvalues [{p.upvalues.map((u) => u.name).join(', ')}]</>
              )}
            </span>
          </div>
          <table className="disasm">
            <tbody>
              {disassemble(p).map((line, j) => (
                <tr key={j}>
                  <td className="da-off">{line.offset.toString().padStart(3, '0')}</td>
                  <td className="da-op">{line.name}</td>
                  <td className="da-arg">{line.operand !== null ? line.operand : ''}</td>
                  <td className="da-comment">{line.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
