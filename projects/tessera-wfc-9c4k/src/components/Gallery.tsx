import { useMemo } from 'react';
import type { CompiledTileset } from '../wfc/types';

const MAX_SHOWN = 120; // overlapping models can learn hundreds of patterns — cap the DOM

export default function Gallery({ tileset }: { tileset: CompiledTileset }) {
  const isOverlap = tileset.key.startsWith('overlap:');
  const { items, total } = useMemo(() => {
    const all = tileset.variants;
    const shown = all.slice(0, MAX_SHOWN).map((v) => ({
      id: v.id,
      src: (v.patternBitmap ?? v.bitmap).toDataURL(),
      weight: v.weight,
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
        </span>
      </header>
      <div className="tile-grid">
        {items.map((it) => (
          <figure
            key={it.id}
            className="tile"
            title={`${it.proto} · ${isOverlap ? 'frequency' : 'weight'} ${Math.round(it.weight)}`}
          >
            <img src={it.src} alt={it.proto} width={40} height={40} />
          </figure>
        ))}
      </div>
      {total > MAX_SHOWN && <p className="muted gallery-more">+{total - MAX_SHOWN} more not shown</p>}
    </section>
  );
}
