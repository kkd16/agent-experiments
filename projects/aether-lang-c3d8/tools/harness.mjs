// Aether — headless semantic harness.
//
// Runs Aether programs through the real pipeline (lexer → parser → HM inference
// → dictionary-passing elaboration → bytecode VM), and the JavaScript backend,
// asserting the two backends agree byte-for-byte. Used during development to
// guard the language against regressions; run with:
//   node --experimental-strip-types tools/harness.mjs
import { runPipeline } from '../src/lang/pipeline.ts'
import { compileToJs, runJsModule } from '../src/lang/jsBackend.ts'
import { valueToString } from '../src/lang/values.ts'
import { EXAMPLES } from '../src/examples.ts'

let pass = 0
let fail = 0
const failures = []

function record(name, ok, detail) {
  if (ok) {
    pass++
  } else {
    fail++
    failures.push(`${name}: ${detail}`)
  }
}

/** Run a program; assert it type-checks, produces `type`/`value`/`output`, and JS≡VM. */
export function check(name, src, expect = {}) {
  const r = runPipeline(src, { execute: true })
  if (expect.error) {
    record(name, !!r.error && (r.error.message.includes(expect.error)), `expected error ~"${expect.error}", got ${r.error ? r.error.message : 'no error'}`)
    return
  }
  if (r.error) {
    record(name, false, `unexpected ${r.error.stage} error: ${r.error.message}`)
    return
  }
  if (expect.type !== undefined) {
    record(name + ' [type]', r.programType === expect.type, `type was "${r.programType}", expected "${expect.type}"`)
  }
  const vmVal = r.run && r.run.result ? valueToString(r.run.result) : null
  if (expect.value !== undefined) {
    record(name + ' [value]', vmVal === expect.value, `value was "${vmVal}", expected "${expect.value}"`)
  }
  if (expect.output !== undefined) {
    const out = r.run ? r.run.output.join('\n') : ''
    record(name + ' [output]', out === expect.output, `output was ${JSON.stringify(out)}, expected ${JSON.stringify(expect.output)}`)
  }
  // JS ≡ VM equivalence on the elaborated core
  if (r.coreAst && !expect.skipJs) {
    const mod = compileToJs(r.coreAst)
    const js = runJsModule(mod.full)
    if (js.error) {
      record(name + ' [js≡vm]', false, `JS backend error: ${js.error}`)
    } else {
      const sameResult = js.result === vmVal
      const sameOut = (r.run ? r.run.output.join('\n') : '') === js.output.join('\n')
      record(name + ' [js≡vm]', sameResult && sameOut, `JS result "${js.result}" out ${JSON.stringify(js.output)} vs VM "${vmVal}" out ${JSON.stringify(r.run ? r.run.output : [])}`)
    }
  }
}

// All gallery examples must type-check, run, and match across backends.
for (const ex of EXAMPLES) {
  check('example:' + ex.id, ex.code, {})
}

if (process.argv[2] !== '--examples-only') {
  // hook for additional suites appended below via import
}

console.log(`\nAether harness: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
