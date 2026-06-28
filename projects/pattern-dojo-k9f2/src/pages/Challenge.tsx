import { useMemo, useRef, useState } from "react";
import { challengeById } from "../dojo/challenges";
import { runTests } from "../dojo/runner";
import type { RunOutcome, CaseResult } from "../dojo/runner";
import { display } from "../dojo/equal";
import { loadDraft, saveDraft, clearDraft, useDojo } from "../dojo/store";
import { patternById } from "../data/patterns";
import { href, navigate } from "../lib/router";
import { useSRS } from "../lib/srs";
import { useStreak } from "../lib/streak";
import CodeBlock from "../components/CodeBlock";
import { Difficulty } from "../components/ui";
import CodeEditor from "../components/CodeEditor";
import ComplexityProfiler from "../components/ComplexityProfiler";

const STATUS_LABEL: Record<CaseResult["status"], string> = {
  pass: "Passed",
  wrong: "Wrong answer",
  error: "Runtime error",
  tle: "Time limit",
};

function CaseRow({ c, idx }: { c: CaseResult; idx: number }) {
  const [open, setOpen] = useState(c.status !== "pass");
  return (
    <div className={`case-row ${c.status}`}>
      <button className="case-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`case-pip ${c.status}`} aria-hidden="true">
          {c.status === "pass" ? "✓" : c.status === "wrong" ? "✗" : c.status === "tle" ? "⏱" : "!"}
        </span>
        <span className="case-label">
          {c.sample ? "Sample" : "Test"} {idx + 1}
          {c.name ? ` — ${c.name}` : ""}
        </span>
        <span className="case-status">{STATUS_LABEL[c.status]}</span>
        {c.status === "pass" && <span className="muted small">{c.durationMs} ms</span>}
        <span className="case-toggle" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="case-body">
          <div className="case-kv"><span>Input</span><code>{display(c.args.length === 1 ? c.args[0] : c.args, 400)}</code></div>
          <div className="case-kv"><span>Expected</span><code>{display(c.expected, 400)}</code></div>
          {c.status === "wrong" && <div className="case-kv"><span>Your output</span><code className="bad-text">{display(c.got, 400)}</code></div>}
          {c.status === "error" && <div className="case-kv"><span>Error</span><code className="bad-text">{c.error}</code></div>}
          {c.status === "tle" && <div className="case-kv"><span>Result</span><code className="bad-text">{c.error}</code></div>}
          {c.logs.length > 0 && (
            <div className="case-kv">
              <span>console.log</span>
              <code className="case-logs">{c.logs.join("\n")}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Challenge({ id }: { id: string }) {
  const ch = challengeById(id);
  const dojo = useDojo();
  const srs = useSRS();
  const { recordToday } = useStreak();

  const [code, setCode] = useState<string>(() => loadDraft(id) ?? ch?.starter ?? "");
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"run" | "submit" | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [showSolution, setShowSolution] = useState(false);
  const [justSolved, setJustSolved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The component is remounted (keyed on `id`) when navigating between problems,
  // so the useState initializers above already give each problem a clean slate.

  const sampleTests = useMemo(() => (ch ? ch.tests.filter((t) => t.sample) : []), [ch]);

  if (!ch) {
    return (
      <div className="container narrow">
        <h1>Problem not found</h1>
        <p className="muted">No challenge with id “{id}”.</p>
        <a className="btn" href={href("/practice")}>← Back to Code Dojo</a>
      </div>
    );
  }

  const pattern = patternById(ch.patternId);
  const solved = dojo.isSolved(ch.id);

  const updateCode = (next: string) => {
    setCode(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveDraft(id, next), 250);
  };

  const run = async (which: "run" | "submit") => {
    if (running) return;
    setRunning(true);
    setMode(which);
    setJustSolved(false);
    const tests = which === "run" ? sampleTests : ch.tests;
    const res = await runTests(code, ch, tests);
    setOutcome(res);
    setRunning(false);
    if (res.compileError) {
      dojo.recordAttempt(ch.id);
      return;
    }
    if (which === "submit") {
      if (res.ok) {
        const first = dojo.recordSolve(ch.id, res.totalMs);
        srs.markLearned(ch.patternId);
        if (first) {
          recordToday();
          setJustSolved(true);
        }
      } else {
        dojo.recordAttempt(ch.id);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run("submit");
    }
  };

  const resetCode = () => {
    if (!window.confirm("Reset your code to the starter template? Your current draft will be lost.")) return;
    clearDraft(id);
    setCode(ch.starter);
    setOutcome(null);
    setMode(null);
  };

  return (
    <div className="container challenge-page" onKeyDown={onKeyDown}>
      <div className="challenge-top">
        <a className="back-link" href={href("/practice")}>← Code Dojo</a>
        {pattern && (
          <a className="challenge-pattern-tag" href={href(`/pattern/${pattern.id}`)} style={{ color: pattern.color }}>
            {pattern.icon} {pattern.name}
          </a>
        )}
      </div>

      <div className="challenge-grid">
        {/* ---- problem panel ---- */}
        <div className="challenge-prompt">
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <h1 className="challenge-h1">{ch.title}</h1>
            <Difficulty d={ch.difficulty} />
            {solved && <span className="solved-tag">✓ Solved</span>}
          </div>

          {ch.statement.map((p, i) => (
            <p key={i} className="prompt-para" dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
          ))}

          <div className="signature-box">
            <div className="sig-line"><code>{ch.entry}(…)</code></div>
            {ch.params && ch.params.length > 0 && (
              <ul className="sig-list">
                {ch.params.map((p, i) => <li key={i}><code>{p}</code></li>)}
              </ul>
            )}
            {ch.returns && <div className="sig-returns"><span>returns</span> <code>{ch.returns}</code></div>}
            {ch.complexity && (
              <div className="sig-returns"><span>target</span> <code>time {ch.complexity.time} · space {ch.complexity.space}</code></div>
            )}
          </div>

          <div className="prompt-section">
            <div className="prompt-section-head">
              <h3>Hints</h3>
              {hintsShown < ch.hints.length && (
                <button className="btn ghost sm" onClick={() => setHintsShown((n) => n + 1)}>
                  Reveal {hintsShown === 0 ? "a hint" : "another"}
                </button>
              )}
            </div>
            {hintsShown === 0 && <p className="muted small">Stuck? Reveal hints one at a time.</p>}
            <ol className="hint-list">
              {ch.hints.slice(0, hintsShown).map((h, i) => <li key={i}>{h}</li>)}
            </ol>
          </div>

          <div className="prompt-section">
            <div className="prompt-section-head">
              <h3>Reference solution</h3>
              <button className="btn ghost sm" onClick={() => setShowSolution((s) => !s)}>
                {showSolution ? "Hide" : "Reveal"}
              </button>
            </div>
            {showSolution ? (
              <CodeBlock code={ch.reference} lang="js" />
            ) : (
              <p className="muted small">Give it a real attempt first — then compare.</p>
            )}
          </div>
        </div>

        {/* ---- editor + results ---- */}
        <div className="challenge-work">
          <div className="editor-toolbar">
            <button className="btn" onClick={() => run("run")} disabled={running}>
              {running && mode === "run" ? "Running…" : "▶ Run samples"}
            </button>
            <button className="btn primary" onClick={() => run("submit")} disabled={running} title="Submit (⌘/Ctrl+Enter)">
              {running && mode === "submit" ? "Judging…" : "✓ Submit"}
            </button>
            <button className="btn ghost sm" onClick={resetCode} disabled={running}>Reset</button>
          </div>

          <CodeEditor value={code} onChange={updateCode} ariaLabel={`Solution editor for ${ch.title}`} />

          <div className="results-panel">
            {!outcome && !running && (
              <p className="muted small results-empty">
                Run the sample tests, or Submit to run the full hidden judge set. Infinite loops are
                stopped automatically and reported as a time limit.
              </p>
            )}
            {running && <p className="muted small results-empty">Running your code in the sandbox…</p>}

            {outcome && !running && (
              <>
                {outcome.compileError ? (
                  <div className="compile-error">
                    <strong>Couldn't run your code</strong>
                    <code>{outcome.compileError}</code>
                  </div>
                ) : (
                  <>
                    <div className={`results-summary ${outcome.ok ? "ok" : "fail"}`}>
                      <span className="results-verdict">
                        {outcome.ok
                          ? mode === "submit"
                            ? "Accepted — all tests passed!"
                            : "All sample tests passed"
                          : `${outcome.passed} / ${outcome.total} passed`}
                      </span>
                      <span className="muted small">{outcome.totalMs} ms</span>
                    </div>
                    {justSolved && (
                      <div className="solve-banner">
                        🎉 First solve! <b>{pattern?.name}</b> just graduated into your spaced-repetition review.
                        <a href={href("/review")}>Review now →</a>
                      </div>
                    )}
                    {outcome.ok && mode === "run" && (
                      <p className="muted small" style={{ margin: "4px 2px" }}>
                        Samples look good — hit <b>Submit</b> to run the full hidden test set.
                      </p>
                    )}
                    <div className="case-list">
                      {outcome.cases.map((c, i) => <CaseRow key={i} c={c} idx={i} />)}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <ComplexityProfiler ch={ch} code={code} color={pattern?.color} />
        </div>
      </div>

      <div className="challenge-foot">
        <button className="btn ghost sm" onClick={() => navigate("/practice")}>← All problems</button>
        <span className="muted small">⌘/Ctrl + Enter to submit</span>
      </div>
    </div>
  );
}

/** Render inline `code` spans from a plain string, escaping HTML first. */
function inlineCode(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/`([^`]+)`/g, "<code>$1</code>");
}
