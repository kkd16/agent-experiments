import { useEffect, useMemo, useRef, useState } from "react";
import { useHashRoute, href, navigate } from "../lib/router";
import { challengeById } from "../dojo/challenges";
import { runTests } from "../dojo/runner";
import type { RunOutcome } from "../dojo/runner";
import { display } from "../dojo/equal";
import { useDojo } from "../dojo/store";
import { patternById, patterns } from "../data/patterns";
import { useSRS } from "../lib/srs";
import { useStreak } from "../lib/streak";
import CodeEditor from "../components/CodeEditor";
import CodeBlock from "../components/CodeBlock";
import { Difficulty } from "../components/ui";
import { useInterview } from "../interview/store";
import { selectProblems, hashSeed, poolSize } from "../interview/select";
import { scoreSession } from "../interview/score";
import type { Report, ProblemScore } from "../interview/score";
import { makeAttempt, now } from "../interview/types";
import type { Band, FocusMode, LiveSession, SessionConfig } from "../interview/types";

/* ------------------------------------------------------------------ helpers */

function inlineCode(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/`([^`]+)`/g, "<code>$1</code>");
}
function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
function fmtAgo(ts: number, now: number): string {
  const d = now - ts;
  const min = Math.round(d / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(d / 3600000);
  if (hr < 24) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(d / 86400000);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString();
}
const patternName = (id: string) => patternById(id)?.name ?? id;

/** Distinct patterns the candidate struggled with — left unsolved, peeked, or
 *  leaned on ≥2 hints — worth resurfacing in spaced repetition. */
function weakPatternIds(session: LiveSession): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of session.problemIds) {
    const a = session.attempts[id];
    const ch = challengeById(id);
    if (!a || !ch) continue;
    if ((!a.solved || a.peeked || a.hintsUsed >= 2) && !seen.has(ch.patternId)) {
      seen.add(ch.patternId);
      out.push(ch.patternId);
    }
  }
  return out;
}

/* ============================================================== root router */

export default function Interview() {
  const seg = useHashRoute();
  const sub = seg[1] ?? "";
  if (sub === "session") return <Room />;
  if (sub === "report" && seg[2]) return <ReportPage id={seg[2]} />;
  return <Lobby />;
}

/* ==================================================================== lobby */

const DURATIONS = [20, 35, 45, 60];
const COUNTS = [2, 3, 4, 5];
const BANDS: { id: Band; label: string; hint: string }[] = [
  { id: "warmup", label: "Warm-up", hint: "easy → medium" },
  { id: "mixed", label: "Mixed", hint: "the full range" },
  { id: "standard", label: "Standard", hint: "mostly medium" },
  { id: "hard", label: "Onsite", hint: "medium → hard" },
];

interface Preset {
  id: string;
  icon: string;
  label: string;
  blurb: string;
  durationMin: number;
  problemCount: number;
  band: Band;
  focus: FocusMode;
  hintsAllowed: boolean;
}
const PRESETS: Preset[] = [
  { id: "phone", icon: "📞", label: "Phone screen", blurb: "20m · 2 · warm-up", durationMin: 20, problemCount: 2, band: "warmup", focus: "adaptive", hintsAllowed: true },
  { id: "onsite", icon: "🏢", label: "Standard onsite", blurb: "45m · 3 · medium", durationMin: 45, problemCount: 3, band: "standard", focus: "adaptive", hintsAllowed: true },
  { id: "onsite-hard", icon: "🔥", label: "Hard onsite", blurb: "60m · 4 · no hints", durationMin: 60, problemCount: 4, band: "hard", focus: "adaptive", hintsAllowed: false },
  { id: "speed", icon: "⚡", label: "Speed drill", blurb: "20m · 4 · sprint", durationMin: 20, problemCount: 4, band: "warmup", focus: "balanced", hintsAllowed: false },
];

function Lobby() {
  const iv = useInterview();
  const srs = useSRS();
  const dojo = useDojo();
  const [nowTs, setNowTs] = useState(() => now());

  const [durationMin, setDuration] = useState(35);
  const [problemCount, setCount] = useState(3);
  const [band, setBand] = useState<Band>("mixed");
  const [focus, setFocus] = useState<FocusMode>("adaptive");
  const [hintsAllowed, setHints] = useState(true);
  const [seed, setSeed] = useState(() => hashSeed(`${now()}`));

  useEffect(() => {
    const t = setInterval(() => setNowTs(now()), 30000);
    return () => clearInterval(t);
  }, []);

  const config: SessionConfig = useMemo(
    () => ({ seed, durationMin, problemCount, band, focus, hintsAllowed }),
    [seed, durationMin, problemCount, band, focus, hintsAllowed],
  );

  const ctx = useMemo(
    () => ({ masteryOf: (p: string) => srs.masteryOf(p), isSolved: (c: string) => dojo.isSolved(c) }),
    [srs, dojo],
  );

  const preview = useMemo(() => selectProblems(config, ctx), [config, ctx]);
  const available = poolSize(focus, band);
  const shortfall = preview.length < problemCount;

  const activePreset = PRESETS.find(
    (p) => p.durationMin === durationMin && p.problemCount === problemCount && p.band === band && p.focus === focus && p.hintsAllowed === hintsAllowed,
  );
  const applyPreset = (p: Preset) => {
    setDuration(p.durationMin);
    setCount(p.problemCount);
    setBand(p.band);
    setFocus(p.focus);
    setHints(p.hintsAllowed);
    setSeed(hashSeed(`${p.id}:${now()}`));
  };

  const start = () => {
    const ids = preview;
    if (ids.length === 0) return;
    const startedAt = now();
    const attempts: LiveSession["attempts"] = {};
    for (const id of ids) {
      const ch = challengeById(id);
      attempts[id] = makeAttempt(id, ch?.starter ?? "");
    }
    const session: LiveSession = {
      id: `iv-${seed.toString(36)}-${startedAt.toString(36)}`,
      config,
      problemIds: ids,
      startedAt,
      endsAt: startedAt + durationMin * 60000,
      current: 0,
      attempts,
    };
    if (session.problemIds.length > 0) {
      const first = session.attempts[session.problemIds[0]];
      if (first) first.firstViewAt = startedAt;
    }
    iv.setLive(session);
    navigate("/interview/session");
  };

  return (
    <div className="container iv-lobby">
      <div className="iv-hero">
        <span className="eyebrow">The Interview Room</span>
        <h1>
          Simulate the real thing — <span className="grad-text">timed, adaptive, judged</span>.
        </h1>
        <p className="muted hero-sub">
          A countdown, a blank editor and problems chosen to hunt your weakest patterns. Solve
          against the same sandbox judge as the Dojo, then get a readiness scorecard that scores
          speed and independence — not just green checks.
        </p>
      </div>

      {iv.live && <ResumeBanner session={iv.live} now={nowTs} onDiscard={() => iv.abandon()} />}

      <div className="iv-setup-grid">
        <div className="card iv-config">
          <h3 className="iv-config-h">Configure your session</h3>

          <div className="iv-presets" role="group" aria-label="Session presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className={`iv-preset ${activePreset?.id === p.id ? "on" : ""}`}
                onClick={() => applyPreset(p)}
                title={p.blurb}
              >
                <span className="iv-preset-ic">{p.icon}</span>
                <span className="iv-preset-label">{p.label}</span>
                <span className="iv-preset-blurb muted small">{p.blurb}</span>
              </button>
            ))}
          </div>

          <Field label="Time budget">
            <div className="seg">
              {DURATIONS.map((d) => (
                <button key={d} className={d === durationMin ? "on" : ""} onClick={() => setDuration(d)}>
                  {d}m
                </button>
              ))}
            </div>
          </Field>

          <Field label="Problems">
            <div className="seg">
              {COUNTS.map((c) => (
                <button key={c} className={c === problemCount ? "on" : ""} onClick={() => setCount(c)}>
                  {c}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Difficulty">
            <div className="seg wrap">
              {BANDS.map((b) => (
                <button key={b.id} className={b.id === band ? "on" : ""} onClick={() => setBand(b.id)} title={b.hint}>
                  {b.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Focus">
            <select className="iv-select" value={focus} onChange={(e) => setFocus(e.target.value)}>
              <option value="adaptive">Adaptive — drill my weak patterns</option>
              <option value="balanced">Balanced — spread across patterns</option>
              <optgroup label="Single pattern">
                {patterns
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.icon} {p.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </Field>

          <label className="iv-check">
            <input type="checkbox" checked={hintsAllowed} onChange={(e) => setHints(e.target.checked)} />
            <span>Allow staged hints <span className="muted small">(using one costs you on the scorecard)</span></span>
          </label>

          <div className="iv-start-row">
            <button className="btn primary lg" onClick={start} disabled={preview.length === 0}>
              ▶ Start interview
            </button>
            <button className="btn ghost" onClick={() => setSeed(hashSeed(`${now()}:${nowTs}`))} title="Reroll the problem set">
              ⟳ Shuffle
            </button>
          </div>
          {shortfall && (
            <p className="muted small" style={{ marginTop: 8 }}>
              Only {available} problem{available === 1 ? "" : "s"} match this focus/difficulty — the session
              will use {preview.length}.
            </p>
          )}
        </div>

        <div className="card iv-preview">
          <h3 className="iv-config-h">This session</h3>
          <p className="muted small" style={{ marginTop: -4 }}>
            {focus === "adaptive"
              ? "Chosen to target the patterns your spaced-repetition and solve history say are weakest."
              : focus === "balanced"
                ? "A spread across distinct patterns."
                : `Focused on ${patternName(focus)}.`}
          </p>
          <ol className="iv-preview-list">
            {preview.map((id) => {
              const ch = challengeById(id);
              const p = ch ? patternById(ch.patternId) : undefined;
              if (!ch) return null;
              return (
                <li key={id}>
                  <span className="iv-preview-icon" style={{ color: p?.color }}>{p?.icon ?? "•"}</span>
                  <span className="iv-preview-title">{ch.title}</span>
                  <span className="iv-preview-pat muted small">{p?.name}</span>
                  <Difficulty d={ch.difficulty} />
                </li>
              );
            })}
            {preview.length === 0 && <li className="muted">No problems match — widen the difficulty band.</li>}
          </ol>
          <div className="iv-preview-foot muted small">
            {durationMin} minutes · {preview.length} problem{preview.length === 1 ? "" : "s"} · judged in a sandbox
          </div>
        </div>
      </div>

      <History iv={iv} now={nowTs} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="iv-field">
      <span className="iv-field-label">{label}</span>
      {children}
    </div>
  );
}

function ResumeBanner({ session, now, onDiscard }: { session: LiveSession; now: number; onDiscard: () => void }) {
  const remaining = Math.max(0, session.endsAt - now);
  const expired = remaining <= 0;
  return (
    <div className="iv-resume">
      <div>
        <b>{expired ? "You have an unfinished session." : "Session in progress."}</b>{" "}
        <span className="muted">
          {session.problemIds.length} problems ·{" "}
          {expired ? "time's up — see how you did." : `${fmtClock(remaining / 1000)} left`}
        </span>
      </div>
      <div className="row">
        <a className="btn primary" href={href("/interview/session")}>{expired ? "Finish & score" : "Resume"} →</a>
        <button className="btn ghost sm" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  );
}

/* ================================================================= history */

function History({ iv, now }: { iv: ReturnType<typeof useInterview>; now: number }) {
  const reports = useMemo(
    () => iv.history.map((s) => ({ s, r: scoreSession(s, patternName) })),
    [iv.history],
  );
  if (reports.length === 0) {
    return (
      <div className="iv-history-empty muted">
        No sessions yet. Your scorecards and a readiness trend will build up here as you practise.
      </div>
    );
  }
  const trend = reports.map((x) => x.r.overall).reverse(); // oldest → newest
  const best = Math.max(...reports.map((x) => x.r.overall));

  return (
    <section className="iv-history">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Your sessions</h2>
        <div className="row">
          <span className="muted small">best {best} · {reports.length} logged</span>
          <button className="btn ghost sm" onClick={() => { if (window.confirm("Clear all recorded sessions?")) iv.clearHistory(); }}>
            Clear
          </button>
        </div>
      </div>

      {trend.length >= 2 && (
        <div className="card iv-trend">
          <div className="iv-trend-head">
            <span className="eyebrow">Readiness trend</span>
            <span className="muted small">oldest → newest</span>
          </div>
          <Sparkline values={trend} />
        </div>
      )}

      <div className="iv-history-list">
        {reports.map(({ s, r }) => (
          <a key={s.id} className="iv-history-row" href={href(`/interview/report/${s.id}`)}>
            <span className={`iv-grade g${r.grade}`}>{r.grade}</span>
            <div className="iv-history-main">
              <div className="iv-history-title">
                {r.overall} readiness · {r.solved}/{r.total} solved
              </div>
              <div className="muted small">
                {r.problems.map((p) => p.patternName).join(" · ")}
              </div>
            </div>
            <div className="iv-history-meta muted small">
              {s.config.durationMin}m · {s.finishedAt ? fmtAgo(s.finishedAt, now) : "—"}
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const W = 520, H = 72, pad = 8;
  const n = values.length;
  const max = 100, min = 0;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, n - 1);
  const y = (v: number) => H - pad - ((v - min) / (max - min)) * (H - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${pad},${H - pad} ${pts} ${(W - pad).toFixed(1)},${H - pad}`;
  return (
    <svg className="iv-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Readiness over time">
      {[25, 50, 75].map((g) => (
        <line key={g} x1={pad} x2={W - pad} y1={y(g)} y2={y(g)} className="iv-spark-grid" />
      ))}
      <polygon points={area} className="iv-spark-area" />
      <polyline points={pts} className="iv-spark-line" />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 ? 4 : 2.5} className={i === n - 1 ? "iv-spark-dot last" : "iv-spark-dot"} />
      ))}
    </svg>
  );
}

/* ==================================================================== room */

function Room() {
  const iv = useInterview();
  const session = iv.live;
  const srs = useSRS();
  const dojo = useDojo();
  const { recordToday } = useStreak();

  const [nowTs, setNowTs] = useState(() => now());
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"run" | "submit" | null>(null);
  const [showRef, setShowRef] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finishedRef = useRef(false);
  const loadedId = useRef<string | null>(null);

  const currentId = session ? session.problemIds[session.current] : undefined;
  const ch = currentId ? challengeById(currentId) : undefined;
  const attempt = session && currentId ? session.attempts[currentId] : undefined;

  // Tick the clock once a second.
  useEffect(() => {
    const t = setInterval(() => setNowTs(now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load the current problem's saved draft when the problem changes.
  useEffect(() => {
    if (!session || !currentId) return;
    if (loadedId.current === currentId) return;
    loadedId.current = currentId;
    const a = session.attempts[currentId];
    setCode(a?.code ?? "");
    setOutcome(null);
    setShowRef(false);
    setMode(null);
    if (a && a.firstViewAt === undefined) {
      iv.patchAttempt(currentId, { firstViewAt: now() });
    }
  }, [session, currentId, iv]);

  // Auto-finish when the timer expires.
  const remainingSec = session ? (session.endsAt - nowTs) / 1000 : 0;
  useEffect(() => {
    if (!session || finishedRef.current) return;
    if (remainingSec <= 0) {
      finishedRef.current = true;
      if (currentId) iv.patchAttempt(currentId, { code });
      for (const pid of weakPatternIds(session)) if (srs.isLearned(pid)) srs.grade(pid, 0);
      const done = iv.finish("time");
      if (done) navigate(`/interview/report/${done.id}`);
    }
  }, [remainingSec, session, iv, srs, currentId, code]);

  if (!session || !ch || !currentId || !attempt) {
    return (
      <div className="container narrow" style={{ paddingTop: 48 }}>
        <h1>No active session</h1>
        <p className="muted">Start one from the Interview Room lobby.</p>
        <a className="btn primary" href={href("/interview")}>← Interview Room</a>
      </div>
    );
  }

  const pattern = patternById(ch.patternId);
  const hintsAllowed = session.config.hintsAllowed;
  const danger = remainingSec <= 120;

  const flushCode = (next = code) => iv.patchAttempt(currentId, { code: next });

  const updateCode = (next: string) => {
    setCode(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushCode(next), 400);
  };

  const gotoProblem = (idx: number) => {
    if (idx === session.current) return;
    flushCode();
    loadedId.current = null; // force reload effect
    iv.updateLive((s) => { s.current = idx; });
  };

  const revealHint = () => {
    if (!hintsAllowed) return;
    if (attempt.hintsUsed >= ch.hints.length) return;
    iv.patchAttempt(currentId, { hintsUsed: attempt.hintsUsed + 1 });
  };

  const revealReference = () => {
    setShowRef(true);
    if (!attempt.peeked) iv.patchAttempt(currentId, { peeked: true });
  };

  const run = async (which: "run" | "submit") => {
    if (running) return;
    setRunning(true);
    setMode(which);
    flushCode();
    const tests = which === "run" ? ch.tests.filter((t) => t.sample) : ch.tests;
    const res = await runTests(code, ch, tests);
    setOutcome(res);
    setRunning(false);

    const ratio = res.total > 0 ? res.passed / res.total : 0;
    const patch: Partial<typeof attempt> = {};
    if (which === "submit") {
      patch.submits = attempt.submits + 1;
      if (!res.compileError) patch.bestRatio = Math.max(attempt.bestRatio, ratio);
      if (res.ok && !attempt.solved) {
        patch.solved = true;
        patch.firstPassAt = now();
        patch.bestMs = res.totalMs;
        // Fold the win back into the rest of the app.
        srs.markLearned(ch.patternId);
        dojo.recordSolve(ch.id, res.totalMs);
        recordToday();
      }
    } else {
      patch.runs = attempt.runs + 1;
    }
    iv.patchAttempt(currentId, patch);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run("submit");
    }
  };

  const endNow = () => {
    if (!window.confirm("End the interview now and see your scorecard?")) return;
    finishedRef.current = true;
    flushCode();
    for (const pid of weakPatternIds(session)) if (srs.isLearned(pid)) srs.grade(pid, 0);
    const done = iv.finish("manual");
    if (done) navigate(`/interview/report/${done.id}`);
  };

  const solvedCount = session.problemIds.filter((id) => session.attempts[id]?.solved).length;

  return (
    <div className="iv-room" onKeyDown={onKeyDown}>
      {/* ---- sticky command bar ---- */}
      <div className="iv-bar">
        <div className="iv-bar-left">
          <a className="iv-bar-exit" href={href("/interview")} title="Back to lobby (session is saved)">‹ Room</a>
          <div className="iv-dots">
            {session.problemIds.map((id, i) => {
              const a = session.attempts[id];
              const cls = a?.solved ? "solved" : i === session.current ? "current" : a?.submits ? "tried" : "";
              return (
                <button key={id} className={`iv-dot ${cls}`} onClick={() => gotoProblem(i)} title={challengeById(id)?.title} aria-label={`Problem ${i + 1}`}>
                  {a?.solved ? "✓" : i + 1}
                </button>
              );
            })}
          </div>
        </div>
        <div className={`iv-clock ${danger ? "danger" : ""}`} role="timer">
          {fmtClock(remainingSec)}
        </div>
        <div className="iv-bar-right">
          <span className="muted small">{solvedCount}/{session.problemIds.length} solved</span>
          <button className="btn primary sm" onClick={endNow}>End & score</button>
        </div>
      </div>

      <div className="iv-room-grid container">
        {/* ---- problem panel ---- */}
        <div className="iv-problem">
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <h1 className="challenge-h1">{ch.title}</h1>
            <Difficulty d={ch.difficulty} />
            {attempt.solved && <span className="solved-tag">✓ Solved</span>}
          </div>
          {pattern && (
            <div className="iv-problem-pat" style={{ color: pattern.color }}>
              {pattern.icon} {pattern.name}
            </div>
          )}

          {ch.statement.map((p, i) => (
            <p key={i} className="prompt-para" dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
          ))}

          <div className="signature-box">
            <div className="sig-line"><code>{ch.entry}(…)</code></div>
            {ch.params && ch.params.length > 0 && (
              <ul className="sig-list">{ch.params.map((p, i) => <li key={i}><code>{p}</code></li>)}</ul>
            )}
            {ch.returns && <div className="sig-returns"><span>returns</span> <code>{ch.returns}</code></div>}
          </div>

          <div className="prompt-section">
            <div className="prompt-section-head">
              <h3>Interviewer</h3>
              {hintsAllowed && attempt.hintsUsed < ch.hints.length && (
                <button className="btn ghost sm" onClick={revealHint}>
                  {attempt.hintsUsed === 0 ? "Ask for a hint" : "Ask for another"}
                </button>
              )}
            </div>
            {!hintsAllowed ? (
              <p className="muted small">Hints are disabled for this session — you're on your own, like the real thing.</p>
            ) : attempt.hintsUsed === 0 ? (
              <p className="muted small">Stuck? You can ask for staged hints — but each one is noted on your scorecard.</p>
            ) : (
              <ol className="hint-list">
                {ch.hints.slice(0, attempt.hintsUsed).map((h, i) => <li key={i}>{h}</li>)}
              </ol>
            )}
          </div>

          <div className="prompt-section">
            <div className="prompt-section-head">
              <h3>Reference solution</h3>
              <button className="btn ghost sm" onClick={() => (showRef ? setShowRef(false) : revealReference())}>
                {showRef ? "Hide" : "Reveal"}
              </button>
            </div>
            {showRef ? (
              <CodeBlock code={ch.reference} lang="js" />
            ) : (
              <p className="muted small">
                {attempt.peeked ? "Already peeked this problem." : "Peeking caps this problem's score — try to resist."}
              </p>
            )}
          </div>
        </div>

        {/* ---- work panel ---- */}
        <div className="iv-work">
          <div className="editor-toolbar">
            <button className="btn" onClick={() => run("run")} disabled={running}>
              {running && mode === "run" ? "Running…" : "▶ Run samples"}
            </button>
            <button className="btn primary" onClick={() => run("submit")} disabled={running} title="Submit (⌘/Ctrl+Enter)">
              {running && mode === "submit" ? "Judging…" : "✓ Submit"}
            </button>
            {session.current < session.problemIds.length - 1 && (
              <button className="btn ghost sm" onClick={() => gotoProblem(session.current + 1)} disabled={running}>
                Next problem →
              </button>
            )}
          </div>

          <CodeEditor value={code} onChange={updateCode} ariaLabel={`Solution editor for ${ch.title}`} />

          <div className="results-panel">
            {!outcome && !running && (
              <p className="muted small results-empty">
                Run the samples, or Submit to run the full hidden judge set. Your draft is saved automatically.
              </p>
            )}
            {running && <p className="muted small results-empty">Running your code in the sandbox…</p>}
            {outcome && !running && <Results outcome={outcome} mode={mode} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Compact results renderer (shares CSS with the Dojo's case list). */
function Results({ outcome, mode }: { outcome: RunOutcome; mode: "run" | "submit" | null }) {
  if (outcome.compileError) {
    return (
      <div className="compile-error">
        <strong>Couldn't run your code</strong>
        <code>{outcome.compileError}</code>
      </div>
    );
  }
  return (
    <>
      <div className={`results-summary ${outcome.ok ? "ok" : "fail"}`}>
        <span className="results-verdict">
          {outcome.ok
            ? mode === "submit" ? "Accepted — all tests passed!" : "All sample tests passed"
            : `${outcome.passed} / ${outcome.total} passed`}
        </span>
        <span className="muted small">{outcome.totalMs} ms</span>
      </div>
      <div className="case-list">
        {outcome.cases.map((c, i) => {
          const pip = c.status === "pass" ? "✓" : c.status === "wrong" ? "✗" : c.status === "tle" ? "⏱" : "!";
          return (
            <div key={i} className={`case-row ${c.status}`}>
              <div className="case-head" style={{ cursor: "default" }}>
                <span className={`case-pip ${c.status}`} aria-hidden="true">{pip}</span>
                <span className="case-label">{c.sample ? "Sample" : "Test"} {i + 1}{c.name ? ` — ${c.name}` : ""}</span>
                <span className="case-status">
                  {c.status === "pass" ? "Passed" : c.status === "wrong" ? "Wrong answer" : c.status === "tle" ? "Time limit" : "Runtime error"}
                </span>
              </div>
              {c.status !== "pass" && (
                <div className="case-body">
                  <div className="case-kv"><span>Input</span><code>{display(c.args.length === 1 ? c.args[0] : c.args, 300)}</code></div>
                  <div className="case-kv"><span>Expected</span><code>{display(c.expected, 300)}</code></div>
                  {c.status === "wrong" && <div className="case-kv"><span>Your output</span><code className="bad-text">{display(c.got, 300)}</code></div>}
                  {c.status === "error" && <div className="case-kv"><span>Error</span><code className="bad-text">{c.error}</code></div>}
                  {c.status === "tle" && <div className="case-kv"><span>Result</span><code className="bad-text">{c.error}</code></div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ================================================================== report */

function ReportPage({ id }: { id: string }) {
  const iv = useInterview();
  const session = iv.byId(id);

  if (!session) {
    return (
      <div className="container narrow" style={{ paddingTop: 48 }}>
        <h1>Scorecard not found</h1>
        <p className="muted">This session isn't in your history.</p>
        <a className="btn primary" href={href("/interview")}>← Interview Room</a>
      </div>
    );
  }
  const report = scoreSession(session, patternName);
  return <ReportView report={report} config={session.config} />;
}

function ReportView({ report, config }: { report: Report; config: SessionConfig }) {
  const R = 54, C = 2 * Math.PI * R;
  const dash = (report.overall / 100) * C;

  return (
    <div className="container iv-report">
      <a className="back-link" href={href("/interview")}>← Interview Room</a>

      <div className="iv-report-head card">
        <div className="iv-ring-wrap">
          <svg className="iv-ring" viewBox="0 0 140 140" aria-hidden="true">
            <circle cx="70" cy="70" r={R} className="iv-ring-track" />
            <circle
              cx="70" cy="70" r={R}
              className={`iv-ring-fill g${report.grade}`}
              strokeDasharray={`${dash} ${C - dash}`}
              transform="rotate(-90 70 70)"
            />
          </svg>
          <div className="iv-ring-center">
            <div className="iv-ring-num">{report.overall}</div>
            <div className="iv-ring-cap">readiness</div>
          </div>
        </div>
        <div className="iv-report-headline">
          <div className={`iv-grade-big g${report.grade}`}>{report.grade}</div>
          <h1 style={{ margin: "2px 0 4px" }}>{report.gradeLabel}</h1>
          <div className="iv-report-stats">
            <Stat n={`${report.solved}/${report.total}`} l="solved" />
            <Stat n={`${report.elapsedMin}m`} l={`of ${report.budgetMin}m`} />
            <Stat n={report.avgSolveMin === null ? "—" : `${report.avgSolveMin}m`} l="avg solve" />
            <Stat n={`${report.totalHints}`} l={`hint${report.totalHints === 1 ? "" : "s"}`} />
          </div>
        </div>
      </div>

      <div className="iv-report-cols">
        <div className="iv-feedback card">
          <h3>Coach's notes</h3>
          <ul className="iv-feedback-list">
            {report.feedback.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
          {report.drill.length > 0 && (
            <>
              <h4 className="iv-drill-h">Drill these next</h4>
              <p className="muted small" style={{ margin: "-4px 0 10px" }}>
                Any of these you'd already learned were bumped up your spaced-repetition queue.
              </p>
              <div className="iv-drill">
                {report.drill.map((d) => {
                  const p = patternById(d.patternId);
                  return (
                    <a key={d.patternId} className="iv-drill-chip" href={href(`/pattern/${d.patternId}`)} style={{ borderColor: `${p?.color ?? "#888"}66` }}>
                      <span style={{ color: p?.color }}>{p?.icon}</span> {d.patternName}
                      <span className="muted small"> · {d.reason}</span>
                    </a>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="iv-breakdown card">
          <h3>Problem by problem</h3>
          <div className="iv-prob-list">
            {report.problems.map((p) => <ProblemRow key={p.id} p={p} />)}
          </div>
        </div>
      </div>

      <div className="iv-report-actions">
        <a className="btn primary" href={href("/interview")}>Run another session →</a>
        <a className="btn ghost" href={href("/practice")}>Open the Code Dojo</a>
        <span className="muted small">
          {config.focus === "adaptive" ? "Adaptive" : config.focus === "balanced" ? "Balanced" : patternName(config.focus)} · {config.durationMin}m budget
        </span>
      </div>
    </div>
  );
}

function Stat({ n, l }: { n: React.ReactNode; l: string }) {
  return (
    <div className="iv-stat">
      <div className="iv-stat-n">{n}</div>
      <div className="iv-stat-l muted small">{l}</div>
    </div>
  );
}

function ProblemRow({ p }: { p: ProblemScore }) {
  const pat = patternById(p.patternId);
  const bar = Math.max(4, p.score);
  return (
    <div className={`iv-prob ${p.solved ? "solved" : "unsolved"}`}>
      <div className="iv-prob-top">
        <span className="iv-prob-status" aria-hidden="true">{p.solved ? "✓" : "○"}</span>
        <a className="iv-prob-title" href={href(`/practice/${p.id}`)}>{p.title}</a>
        <Difficulty d={p.difficulty} />
        <span className="iv-prob-score">{p.score}</span>
      </div>
      <div className="iv-prob-meter">
        <div className="iv-prob-meter-fill" style={{ width: `${bar}%`, background: pat?.color ?? "var(--accent)" }} />
      </div>
      <div className="iv-prob-note muted small">
        <span style={{ color: pat?.color }}>{pat?.icon} {p.patternName}</span>
        {p.solveMin !== null && <span> · {p.solveMin}m / {p.budgetMin}m budget</span>}
        {p.hintsUsed > 0 && <span> · {p.hintsUsed} hint{p.hintsUsed === 1 ? "" : "s"}</span>}
        {p.peeked && <span> · peeked</span>}
        {" — "}{p.note}
      </div>
    </div>
  );
}
