import type { Progress } from './game/progress'
import type { DisplayDetail, MotionPreference } from './game/presentation'

export function FlightPreferences({
  progress,
  onChange,
  onSound,
}: {
  progress: Progress
  onChange: (next: Progress) => void
  onSound: () => void
}) {
  return (
    <div className="flight-preferences">
      <h3>Make the flight yours</h3>
      <button role="switch" aria-checked={progress.sound} onClick={onSound}>
        <span>
          Flight sounds
          <small>Wind, soft chords, and pickup chimes. M to mute.</small>
        </span>
        <i className={progress.sound ? 'on' : ''} aria-hidden="true" />
      </button>
      <button
        role="switch"
        aria-checked={progress.coach}
        onClick={() => onChange({ ...progress, coach: !progress.coach })}
      >
        <span>
          Flight coaching
          <small>Live cues for holding, releasing, and landing.</small>
        </span>
        <i className={progress.coach ? 'on' : ''} aria-hidden="true" />
      </button>
      <button
        role="switch"
        aria-checked={progress.ghost}
        onClick={() => onChange({ ...progress, ghost: !progress.ghost })}
      >
        <span>
          Race your ghost
          <small>See your best flight on a course you revisit.</small>
        </span>
        <i className={progress.ghost ? 'on' : ''} aria-hidden="true" />
      </button>
      <label className="preference-choice">
        <span>
          Scenery detail
          <small>
            {progress.detail === 'sharp'
              ? 'Extra sharp scenery on high-resolution screens.'
              : progress.detail === 'light'
                ? 'Lighter drawing for cooler, longer play.'
                : 'Balances scenery sharpness with smooth flight.'}{' '}
            All choices keep the same flight speed.
          </small>
        </span>
        <select
          value={progress.detail}
          onChange={(event) =>
            onChange({
              ...progress,
              detail: event.target.value as DisplayDetail,
            })
          }
        >
          <option value="auto">Automatic</option>
          <option value="sharp">Sharp</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="preference-choice">
        <span>
          Motion
          <small>
            Reduced motion removes screen shake, speed streaks, and ambient
            animation.
          </small>
        </span>
        <select
          value={progress.motion}
          onChange={(event) =>
            onChange({
              ...progress,
              motion: event.target.value as MotionPreference,
            })
          }
        >
          <option value="system">Follow device</option>
          <option value="reduced">Reduced</option>
          <option value="full">Full</option>
        </select>
      </label>
      <p className="preferences-note">
        Saved on this device. Your route, rewards, and skiff handling stay the
        same.
      </p>
    </div>
  )
}
