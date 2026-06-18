import { useMemo } from 'react';
import type { CompiledTileset } from '../wfc/types';

export default function Gallery({ tileset }: { tileset: CompiledTileset }) {
  const items = useMemo(
    () =>
      tileset.variants.map((v) => ({
        id: v.id,
        src: v.bitmap.toDataURL(),
        weight: v.weight,
        proto: v.proto,
      })),
    [tileset],
  );
  return (
    <section className="panel gallery">
      <header className="panel-head">
        <h2>Tiles</h2>
        <span className="muted">{items.length} variants</span>
      </header>
      <div className="tile-grid">
        {items.map((it) => (
          <figure key={it.id} className="tile" title={`${it.proto} · weight ${it.weight}`}>
            <img src={it.src} alt={it.proto} width={40} height={40} />
          </figure>
        ))}
      </div>
    </section>
  );
}
