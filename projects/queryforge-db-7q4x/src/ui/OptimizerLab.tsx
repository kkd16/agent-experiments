// The Optimizer Lab — a hands-on tour of the cost-based optimizer.
//
// Paste a SELECT and the lab shows three things the planner normally keeps to
// itself: (1) the plan it chose, with per-operator cost; (2) the join-order
// subset-DP search — every relation subset, the cheapest plan found for it, and
// the order the search settled on; and (3) the what-if Index Advisor's ranked
// recommendations, each with a one-click "apply" that creates the index and
// re-plans so you watch the winning plan change. It is the Concurrency Lab's
// twin: an invisible subsystem made legible.

import { useMemo, useState } from 'react'
import type { Engine } from '../db/engine'
import type { AdviceResult, IndexRecommendation } from '../db/advisor'
import type { JoinOrderTrace } from '../db/planner'
import type { PlanNode } from '../db/operators'
import { PlanTree } from './PlanTree'

const SAMPLES: { label: string; sql: string }[] = [
  {
    label: '3-way join + filter',
    sql: "SELECT o.id, c.name, p.name\nFROM orders o\n  JOIN customers c ON o.customer_id = c.id\n  JOIN products p ON o.product_id = p.id\nWHERE c.country = 'UK'",
  },
  {
    label: 'selective equality',
    sql: "SELECT * FROM customers WHERE country = 'UK'",
  },
  {
    label: 'range + order by',
    sql: 'SELECT name, price FROM products WHERE price >= 100 ORDER BY price',
  },
  {
    label: '4-way star',
    sql: "SELECT o.id, c.name, p.name\nFROM orders o\n  JOIN customers c ON o.customer_id = c.id\n  JOIN products p ON o.product_id = p.id\n  JOIN invoices i ON i.customer_id = c.id\nWHERE c.country = 'UK' AND p.price > 50",
  },
]

interface Analysis {
  ok: boolean
  error?: string
  plan?: PlanNode
  trace?: JoinOrderTrace | null
  advice?: AdviceResult
}

function totalCost(n: PlanNode): number {
  return n.estCost
}

export function OptimizerLab({
  engine,
  version,
  onApply,
}: {
  engine: Engine
  version: number
  onApply: (ddl: string) => void
}) {
  const [draft, setDraft] = useState(SAMPLES[0].sql)
  const [submitted, setSubmitted] = useState(SAMPLES[0].sql)

  // Re-analyze whenever the submitted query changes or the database changes
  // (e.g. after applying a recommended index, `version` bumps).
  const analysis = useMemo<Analysis>(() => {
    try {
      const { plan, trace } = engine.planAndTrace(submitted)
      const advice = engine.advise(submitted)
      return { ok: true, plan, trace, advice }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, submitted, version])

  return (
    <div className="optlab">
      <div className="optlab-intro">
        <h2>Optimizer Lab</h2>
        <p>
          Watch the cost-based optimizer think. The planner estimates a <strong>cost</strong> for every
          operator, searches join orders with a Selinger subset-DP, and picks the cheapest tree. The{' '}
          <strong>Index Advisor</strong> then asks "what if this index existed?" — building each candidate{' '}
          <em>hypothetically</em>, re-planning, and recommending only the indexes the planner would actually
          adopt. Nothing here changes your data until you click <strong>Apply</strong>.
        </p>
      </div>

      <div className="optlab-input">
        <div className="optlab-samples">
          {SAMPLES.map((s) => (
            <button
              key={s.label}
              className="chip"
              onClick={() => {
                setDraft(s.sql)
                setSubmitted(s.sql)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <textarea
          className="optlab-editor"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(8, Math.max(3, draft.split('\n').length))}
        />
        <button className="btn run" onClick={() => setSubmitted(draft)}>
          Analyze ▸
        </button>
      </div>

      {!analysis.ok ? (
        <div className="optlab-error">⚠ {analysis.error}</div>
      ) : (
        <div className="optlab-grid">
          <section className="optlab-card">
            <h3>Chosen plan</h3>
            <div className="optlab-costline">
              total estimated cost <strong>{totalCost(analysis.plan!).toFixed(2)}</strong> · ~
              {Math.round(analysis.plan!.estRows)} rows out
            </div>
            <PlanTree plan={analysis.plan!} analyze={false} />
          </section>

          <section className="optlab-card">
            <h3>Join-order search</h3>
            {analysis.trace ? (
              <JoinOrderView trace={analysis.trace} />
            ) : (
              <p className="optlab-empty">
                This query has fewer than three freely-reorderable inner joins, so the subset-DP search
                doesn't run — the planner keeps the written order. Try the <em>3-way join</em> or{' '}
                <em>4-way star</em> sample.
              </p>
            )}
          </section>

          <section className="optlab-card optlab-advisor">
            <h3>Index Advisor</h3>
            <AdvisorView advice={analysis.advice!} onApply={onApply} />
          </section>
        </div>
      )}
    </div>
  )
}

function JoinOrderView({ trace }: { trace: JoinOrderTrace }) {
  const considered = trace.candidates.length
  return (
    <div className="joinorder">
      <div className="joinorder-meta">
        <span>
          {trace.relations.length} relations · {considered} subset-extensions costed
        </span>
        <div className="joinorder-final">
          winning order:{' '}
          {trace.finalOrder.map((r, i) => (
            <span key={i}>
              {i > 0 && <span className="arrow"> ⋈ </span>}
              <span className="rel">{r}</span>
            </span>
          ))}
          <span className="joinorder-finalcost"> (cost {trace.finalCost.toFixed(2)})</span>
        </div>
      </div>
      <table className="joinorder-table">
        <thead>
          <tr>
            <th>relation subset</th>
            <th>best operator</th>
            <th className="num">est. rows</th>
            <th className="num">est. cost</th>
          </tr>
        </thead>
        <tbody>
          {trace.best.map((b) => (
            <tr key={b.mask} className={b.relNames.length === trace.relations.length ? 'full' : ''}>
              <td>
                {b.relNames.map((r, i) => (
                  <span key={i} className="rel">
                    {r}
                  </span>
                ))}
              </td>
              <td className="mono">{b.op}</td>
              <td className="num">{Math.round(b.rows)}</td>
              <td className="num">{b.cost.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="joinorder-note">
        Each row is the cheapest plan the optimizer found for that subset of relations; larger subsets are
        built by extending smaller ones (dynamic programming), so the full set inherits the best of every
        sub-plan.
      </p>
    </div>
  )
}

function AdvisorView({ advice, onApply }: { advice: AdviceResult; onApply: (ddl: string) => void }) {
  if (!advice.ok) return <div className="optlab-error">⚠ {advice.message}</div>
  const { recommendations, candidatesConsidered, alreadyIndexed, baselineCost } = advice
  return (
    <div className="advisor">
      <div className="advisor-meta">
        {candidatesConsidered} candidate index{candidatesConsidered === 1 ? '' : 'es'} costed against a baseline
        of <strong>{baselineCost.toFixed(2)}</strong>.
      </div>
      {alreadyIndexed.length > 0 && (
        <div className="advisor-existing">
          already indexed:{' '}
          {alreadyIndexed.map((s, i) => (
            <span key={i} className="chip small">
              {s}
            </span>
          ))}
        </div>
      )}
      {recommendations.length === 0 ? (
        <p className="optlab-empty">
          No index would lower this plan's estimated cost — for this data and query, the current access paths
          are already optimal. (Indexes help most on selective filters over larger tables.)
        </p>
      ) : (
        <ol className="advisor-list">
          {recommendations.map((r, i) => (
            <RecCard key={i} rec={r} rank={i + 1} onApply={onApply} />
          ))}
        </ol>
      )}
    </div>
  )
}

function RecCard({ rec, rank, onApply }: { rec: IndexRecommendation; rank: number; onApply: (ddl: string) => void }) {
  const pct = Math.round(rec.improvementPct)
  return (
    <li className="rec">
      <div className="rec-head">
        <span className="rec-rank">#{rank}</span>
        <code className="rec-ddl">{rec.ddl}</code>
        <button className="btn small" onClick={() => onApply(rec.ddl)} title="Create this index, then re-plan">
          Apply
        </button>
      </div>
      <div className="rec-reason">{rec.reason}</div>
      <div className="rec-costs">
        <span>
          cost {rec.baselineCost.toFixed(2)} → <strong>{rec.newCost.toFixed(2)}</strong>
        </span>
        <span className={`rec-badge ${pct >= 50 ? 'big' : ''}`}>−{pct}%</span>
        {rec.adopted && <span className="rec-adopted">planner adopts it ✓</span>}
      </div>
      <div className="rec-bar">
        <div className="rec-bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </li>
  )
}
