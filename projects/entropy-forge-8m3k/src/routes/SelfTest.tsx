import { useMemo, useState } from 'react'
import { PageHeader, Panel, Stat } from '../components/ui'
import { runSelfTest, summarize } from '../lib/selftest'

export function SelfTest() {
  const [nonce, setNonce] = useState(0)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // nonce is the re-run trigger; runSelfTest has no other inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarize(runSelfTest()), [nonce])

  // Group cases by their group name for a collapsible report.
  const groups = useMemo(() => {
    const map = new Map<string, typeof summary.cases>()
    for (const c of summary.cases) {
      if (!map.has(c.group)) map.set(c.group, [])
      map.get(c.group)!.push(c)
    }
    return [...map.entries()].map(([name, cases]) => ({
      name,
      cases,
      passed: cases.filter((c) => c.pass).length,
    }))
  }, [summary])

  return (
    <div>
      <PageHeader
        kicker="Correctness"
        title="Self-test"
        lede={
          <>
            A codec you cannot trust is worthless. Every codec here must satisfy{' '}
            <code>decode(encode(x)) === x</code> on every input — the whole corpus plus adversarial
            edge cases (empty, single-symbol, all-256-bytes, long runs, pseudo-random). Every
            primitive transform must be exactly invertible too. It all runs live, in your browser.
          </>
        }
      />

      <div className="grid grid-4">
        <Stat label="Total checks" value={summary.total} />
        <Stat label="Passed" value={summary.passed} accent />
        <Stat label="Failed" value={summary.failed} sub={summary.failed === 0 ? 'clean' : 'see below'} />
        <Stat label="Status" value={summary.failed === 0 ? '✓ ALL GREEN' : '✗ FAILURES'} />
      </div>

      <Panel
        title="Results by group"
        note="Click a group to expand its per-input checks."
        right={
          <button className="btn small" onClick={() => setNonce((n) => n + 1)}>
            Re-run
          </button>
        }
      >
        {groups.map((g) => (
          <div className="testgroup" key={g.name}>
            <div className="testgroup-head" onClick={() => setOpen((o) => ({ ...o, [g.name]: !o[g.name] }))}>
              <div className="row" style={{ gap: 10 }}>
                <span className={g.passed === g.cases.length ? 'dot-ok' : 'dot-bad'} />
                <b>{g.name}</b>
              </div>
              <span className={`pill ${g.passed === g.cases.length ? 'ok' : 'bad'}`}>
                {g.passed}/{g.cases.length}
              </span>
            </div>
            {open[g.name] &&
              g.cases.map((c, i) => (
                <div className="testrow" key={i}>
                  <span className={c.pass ? 'dot-ok' : 'dot-bad'} />
                  <span className="name">{c.name}</span>
                  <span className="muted mono" style={{ fontSize: 12 }}>
                    {c.detail}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </Panel>
    </div>
  )
}
