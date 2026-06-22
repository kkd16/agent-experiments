import PixelGrid from '../gen/PixelGrid';

export interface GalleryRow {
  label: string;
  cells: Float64Array[];
}

interface Props {
  rows: GalleryRow[];
  imgSize: number;
}

// A class-conditional sample sheet: each row is one trained label, each cell a fresh glyph the model
// dreamed up for that class from a different noise seed. Pure render — the (expensive) sampling is
// driven on demand from the lab so it never runs during a training frame.
export default function SampleGallery({ rows, imgSize }: Props) {
  if (rows.length === 0) {
    return <p className="muted small">Train for a while, then hit <b>↻ resample</b> to generate a sheet of glyphs.</p>;
  }
  return (
    <div className="sample-gallery">
      {rows.map((r, i) => (
        <div className="gallery-row" key={i}>
          <span className="gallery-label mono">{r.label}</span>
          <div className="gallery-cells">
            {r.cells.map((g, j) => (
              <PixelGrid key={j} pixels={g} size={imgSize} cell={4} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
