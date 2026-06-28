import { SCENES, sceneById, type SceneDef } from '../scenes';

const CATEGORIES: SceneDef['category'][] = ['Stacking', 'Joints', 'Soft', 'Fluid', 'MPM', 'Fracture', 'Showcase', 'Materials', 'Stress'];

interface Props {
  active: string;
  onSelect: (id: string) => void;
}

/** Grouped, selectable list of demo scenes with the active one's blurb. */
export default function SceneList({ active, onSelect }: Props) {
  const current = sceneById(active);
  return (
    <div className="scene-list">
      {CATEGORIES.map((cat) => {
        const items = SCENES.filter((s) => s.category === cat);
        if (items.length === 0) return null;
        return (
          <div className="scene-group" key={cat}>
            <h3 className="scene-group-title">{cat}</h3>
            <div className="scene-buttons">
              {items.map((s) => (
                <button
                  key={s.id}
                  className={`scene-btn${s.id === active ? ' active' : ''}`}
                  onClick={() => onSelect(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="scene-desc">
        <strong>{current.name}.</strong> {current.description}
      </div>
    </div>
  );
}
