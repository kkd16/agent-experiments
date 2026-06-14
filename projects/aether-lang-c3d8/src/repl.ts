// REPL evaluation logic.
//
// Aether programs are single expressions, so the REPL keeps top-level
// definitions as source and re-wraps them around each new input as nested
// `let … in` / `type … in` — reusing the whole pipeline with no special VM
// support. A submission is tried first as an expression; if that fails and it
// looks like a bare `let`/`type` definition, it's evaluated as one and stored.

import { runPipeline } from './lang/pipeline.ts'
import type { PipelineResult } from './lang/pipeline.ts'
import { valueToString } from './lang/values.ts'

export interface ReplOutcome {
  display: string
  ok: boolean
  /** the definition text to remember, if this submission defined something */
  newDef: string | null
}

function errStr(r: PipelineResult): string {
  return r.error ? `${r.error.stage} error: ${r.error.message}` : 'error'
}

function wrap(defs: string[], tail: string): string {
  const prefix = defs.length ? defs.join('\nin ') + '\nin ' : ''
  return prefix + tail
}

export function evalRepl(defs: string[], input: string): ReplOutcome {
  const trimmed = input.trim()
  if (!trimmed) return { display: '', ok: false, newDef: null }

  // 1. try the input as a (self-contained) expression
  const asExpr = runPipeline(wrap(defs, trimmed), { record: false })
  if (!asExpr.error) {
    const v = asExpr.run?.result ? valueToString(asExpr.run.result) : '()'
    const printed = asExpr.run && asExpr.run.output.length ? asExpr.run.output.join('\n') + '\n' : ''
    return { display: `${printed}=> ${v} : ${asExpr.programType}`, ok: true, newDef: null }
  }

  // 2. a bare value definition: `let [rec] name … = …`
  const letName = trimmed.match(/^let\s+(?:rec\s+)?([A-Za-z_][A-Za-z0-9_']*)/)
  if (letName) {
    const name = letName[1]
    const r = runPipeline(wrap(defs, `${trimmed}\nin ${name}`), { record: false })
    if (!r.error) {
      const v = r.run?.result ? valueToString(r.run.result) : '()'
      return { display: `${name} : ${r.programType} = ${v}`, ok: true, newDef: trimmed }
    }
    return { display: errStr(r), ok: false, newDef: null }
  }

  // 3. a bare type declaration: `type Name … = …`
  const typeName = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_']*)/)
  if (typeName) {
    const r = runPipeline(wrap(defs, `${trimmed}\nin 0`), { record: false })
    if (!r.error) {
      return { display: `type ${typeName[1]} defined`, ok: true, newDef: trimmed }
    }
    return { display: errStr(r), ok: false, newDef: null }
  }

  // 4. a class / instance declaration: `class Name a where …` / `instance …`
  const className = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_']*)/)
  if (className) {
    const r = runPipeline(wrap(defs, `${trimmed}\nin 0`), { record: false })
    if (!r.error) return { display: `class ${className[1]} defined`, ok: true, newDef: trimmed }
    return { display: errStr(r), ok: false, newDef: null }
  }
  if (/^instance\b/.test(trimmed)) {
    const r = runPipeline(wrap(defs, `${trimmed}\nin 0`), { record: false })
    if (!r.error) return { display: 'instance defined', ok: true, newDef: trimmed }
    return { display: errStr(r), ok: false, newDef: null }
  }

  // otherwise report the original expression error
  return { display: errStr(asExpr), ok: false, newDef: null }
}
