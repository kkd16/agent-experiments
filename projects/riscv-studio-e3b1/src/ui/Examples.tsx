// Example program picker.

import { EXAMPLES } from '../vm/examples';
import type { Example } from '../vm/examples';

interface Props {
  onLoad: (ex: Example) => void;
  activeId: string | null;
}

export default function Examples({ onLoad, activeId }: Props) {
  return (
    <div className="panel examples">
      <div className="panel-head">
        <h2>Examples</h2>
      </div>
      <ul className="example-list">
        {EXAMPLES.map((ex) => (
          <li key={ex.id}>
            <button className={activeId === ex.id ? 'on' : ''} onClick={() => onLoad(ex)}>
              <span className="ex-title">{ex.title}</span>
              <span className="ex-blurb">{ex.blurb}</span>
              <span className={`ex-focus focus-${ex.focus}`}>{ex.focus}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">Loading an example replaces the editor contents.</p>
    </div>
  );
}
