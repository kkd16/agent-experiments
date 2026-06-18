import { useMemo } from 'react';
import type { CompiledTileset } from '../wfc/types';

const MAX_SHOWN = 120; // overlapping models can learn hundreds of patterns — cap the DOM

type Props = {
  tileset: CompiledTileset;
  brush: number | null;
  onPickBrush: (id: number | null) => void;
  onSetWeight: (id: number, weight: number) => void;
  onResetWeights: () => void;
  hasOverrides: boolean;
  defaultWeight: (id: number) => number;
};

export default function Gallery({ tileset, brush, onPickBrush, onSetWeight, onResetWeights, hasOverrides, defaultWeight }: Props) {
  const isOverlap = tileset.key.startsWith('overlap:');
  const { items, total } = useMemo(() => {
    const all = tileset.variants;
    const shown = all.slice(0, MAX_SHOWN).map((v) => ({
      id: v.id,
      src: (v.patternBitmap ?? v.bitmap).toDataURL(),
      weight: tileset.weights[v.id],
      proto: v.proto,
    }));
    return { items: shown, total: all.length };
  }, [tileset]);

  return (
    <section className="panel gallery">
      <header className="panel-head">
        <h2>{isOverlap ? 'Patterns' : 'Tiles'}</h2>
        <span className="muted">
          {total} {isOverlap ? 'learnt' : 'variants'}
          {hasOverrides && (
            <button className="link-btn" type="button" onClick={onResetWeights} title="Reset all weights">
              reset
            </button>
          )}
        </span>
      </header>
      <p className="muted gallery-hint">Click a tile to use it as a paint brush · drag the bar to re-bias its weight.</p>
      <div className="tile-grid">
        {items.map((it) => {
          const def = defaultWeight(it.id);
          const max = Math.max(def * 3, 4);
          const active = brush === it.id;
          const edited = Math.abs(it.weight - def) > 1e-6;
          return (
            <figure key={it.id} className={`tile ${active ? 'brush' : ''}`} title={`${it.proto} · ${isOverlap ? 'frequency' : 'weight'} ${it.weight.toFixed(2)}`}>
              <button className="tile-pick" type="button" onClick={() => onPickBrush(active ? null : it.id)} aria-label={`brush ${it.proto}`}>
                <img src={it.src} alt={it.proto} width={40} height={40} />
              </button>
              <input
                className={`tile-weight ${edited ? 'edited' : ''}`}
                type="range"
                min={0.05}
                max={max}
                step={0.05}
                value={it.weight}
                onChange={(e) => onSetWeight(it.id, Number(e.target.value))}
                title={`weight ${it.weight.toFixed(2)}`}
              />
            </figure>
          );
        })}
      </div>
      {total > MAX_SHOWN && <p className="muted gallery-more">+{total - MAX_SHOWN} more not shown</p>}
    </section>
  );
}
