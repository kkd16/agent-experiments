import { useMemo, useState } from 'react';
import { resolveUnicodeProperty, verifyProperty, SUGGESTED_PROPERTIES } from '../engine/unicode';
import { MAX_CODE_POINT } from '../engine/charset';

interface Props {
  pattern: string;
}

// Pull every \p{…} / \P{…} the current pattern uses, in order, deduped.
function usedProperties(pattern: string): string[] {
  const out: string[] = [];
  const re = /\\[pP]\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    const spec = m[1].trim();
    if (spec && !out.includes(spec)) out.push(spec);
  }
  return out;
}

const fmt = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

// A spread of representative code points from a set's ranges, for a glyph strip.
function sampleGlyphs(ranges: readonly { lo: number; hi: number }[], limit = 48): number[] {
  const out: number[] = [];
  if (ranges.length === 0) return out;
  // Take the low end of each range first, then fill from range interiors.
  for (const r of ranges) {
    if (out.length >= limit) break;
    out.push(r.lo);
  }
  for (const r of ranges) {
    if (out.length >= limit) break;
    if (r.hi > r.lo) out.push(Math.floor((r.lo + r.hi) / 2));
  }
  return out.slice(0, limit);
}

// Is a code point safe to render as a glyph? Skip control / format / surrogate /
// separator code points that would not display (we show their U+ instead).
function renderable(cp: number): boolean {
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0xa0)) return false;
  try {
    const ch = String.fromCodePoint(cp);
    // Whitespace and most format chars match \s or are zero-width — show U+ instead.
    return !/\s|\p{C}|\p{Z}/u.test(ch);
  } catch {
    return false;
  }
}

export function UnicodePanel({ pattern }: Props) {
  const used = useMemo(() => usedProperties(pattern), [pattern]);
  const menu = useMemo(() => {
    const seen = new Set<string>();
    const items: { spec: string; blurb?: string; used: boolean }[] = [];
    for (const spec of used) {
      seen.add(spec);
      items.push({ spec, used: true });
    }
    for (const { spec, blurb } of SUGGESTED_PROPERTIES) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      items.push({ spec, blurb, used: false });
    }
    return items;
  }, [used]);

  const [selected, setSelected] = useState<string>(() => used[0] ?? 'L');
  // Keep the selection valid as the pattern changes.
  const activeSpec = menu.some((m) => m.spec === selected) ? selected : menu[0]?.spec ?? 'L';

  const info = useMemo(() => {
    const set = resolveUnicodeProperty(activeSpec);
    if (!set) return null;
    const check = verifyProperty(activeSpec);
    let total = 0;
    for (const r of set.ranges) total += r.hi - r.lo + 1;
    return { set, check, total };
  }, [activeSpec]);

  return (
    <div className="uni-panel">
      <div className="uni-intro">
        <h3>Unicode property escapes</h3>
        <p className="muted-note">
          <code>\p{'{'}…{'}'}</code> and <code>\P{'{'}…{'}'}</code> are resolved <strong>live from the host’s own
          Unicode database</strong> — the studio never bundles a megabyte of tables. For each property it asks the
          JavaScript engine’s native <code>/\p{'{'}…{'}'}/u</code>, scans the whole code-point space, and coalesces the
          matches into its own range set. So the class is correct <em>by construction</em>, and every road — Thompson,
          Glushkov, derivatives, the syntactic monoid — speaks Unicode for free.
        </p>
      </div>

      <div className="uni-menu">
        {menu.map((m) => (
          <button
            key={m.spec}
            className={`uni-chip${m.spec === activeSpec ? ' active' : ''}${m.used ? ' in-pattern' : ''}`}
            onClick={() => setSelected(m.spec)}
            title={m.used ? 'used in the current pattern' : m.blurb}
          >
            \p{'{'}
            {m.spec}
            {'}'}
          </button>
        ))}
      </div>

      {!info ? (
        <div className="placeholder">No such Unicode property.</div>
      ) : (
        <div className="uni-detail">
          <div className="uni-stats">
            <div className="uni-stat">
              <div className="uni-stat-n">{info.set.ranges.length.toLocaleString()}</div>
              <div className="uni-stat-l">code-point ranges</div>
            </div>
            <div className="uni-stat">
              <div className="uni-stat-n">{info.total.toLocaleString()}</div>
              <div className="uni-stat-l">code points</div>
            </div>
            <div className="uni-stat">
              <div className="uni-stat-n">{((info.total / (MAX_CODE_POINT + 1)) * 100).toFixed(2)}%</div>
              <div className="uni-stat-l">of Unicode</div>
            </div>
          </div>

          <div className={`uni-check ${info.check.ok ? 'good' : 'bad'}`}>
            {info.check.ok ? '✓ ' : '✕ '}
            differential check vs native engine: {info.check.ok ? 'agrees' : `${info.check.mismatches.length} mismatches`} over{' '}
            {info.check.tested.toLocaleString()} sampled code points
            <span className="uni-check-note"> — derived from the host, re-confirmed against it (every range boundary tested).</span>
          </div>

          <div className="uni-section-label">Sample glyphs</div>
          <div className="uni-glyphs">
            {sampleGlyphs(info.set.ranges).map((cp, i) =>
              renderable(cp) ? (
                <span key={i} className="uni-glyph" title={fmt(cp)}>
                  {String.fromCodePoint(cp)}
                </span>
              ) : (
                <span key={i} className="uni-glyph uni-glyph-code" title={fmt(cp)}>
                  {fmt(cp)}
                </span>
              ),
            )}
          </div>

          <div className="uni-section-label">Code-point ranges {info.set.ranges.length > 14 ? '(first 14)' : ''}</div>
          <div className="uni-ranges">
            {info.set.ranges.slice(0, 14).map((r, i) => (
              <span key={i} className="uni-range">
                {r.lo === r.hi ? fmt(r.lo) : `${fmt(r.lo)}–${fmt(r.hi)}`}
              </span>
            ))}
            {info.set.ranges.length > 14 && <span className="uni-range uni-range-more">+{info.set.ranges.length - 14} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
