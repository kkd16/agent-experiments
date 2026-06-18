type Props = {
  brushSrc: string | null; // data-URL preview of the active brush tile, or null
  erase: boolean;
  pinCount: number;
  onErase: (on: boolean) => void;
  onClear: () => void;
};

/**
 * The constraint-painting console. WFC normally fills an empty grid; here you can seed it with
 * fixed cells — pick a brush from the gallery and paint constraints, then let the solver grow a
 * tiling that honours them. Erase removes a pin; clear wipes them all.
 */
export default function PaintPanel({ brushSrc, erase, pinCount, onErase, onClear }: Props) {
  return (
    <section className="panel paint">
      <header className="panel-head">
        <h2>Paint constraints</h2>
        <span className="muted">{pinCount} pinned</span>
      </header>
      <div className="paint-row">
        <div className={`brush-chip ${brushSrc ? 'set' : ''}`}>
          {brushSrc ? <img src={brushSrc} alt="active brush" width={28} height={28} /> : <span>none</span>}
          <em>brush</em>
        </div>
        <button className={`btn ${erase ? 'btn-primary' : ''}`} type="button" onClick={() => onErase(!erase)} title="Toggle erase (X)">
          ⌫ Erase
        </button>
        <button className="btn" type="button" onClick={onClear} disabled={pinCount === 0} title="Remove all pins">
          ✕ Clear
        </button>
      </div>
      <p className="muted paint-hint">
        Pick a tile in the gallery to load the brush, then click or drag on the board to pin cells. The solver re-grows
        around every pin, so you can sketch a layout and let WFC complete it.
      </p>
    </section>
  );
}
