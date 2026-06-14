import { useSettings, LIMITS } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { href } from "../lib/router";

export default function Settings() {
  const { settings, update, reset } = useSettings();
  const { theme, set: setTheme } = useTheme();

  return (
    <div className="container narrow settings-page">
      <span className="eyebrow">Preferences</span>
      <h1 style={{ marginTop: 6 }}>Settings</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Tune your study flow. Everything is saved in this browser.
      </p>

      <section className="settings-card card">
        <h2>Review</h2>

        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-name">Session size</div>
            <div className="faint">Most cards to review in one sitting — caps the due queue.</div>
          </div>
          <div className="setting-control">
            <input
              type="range"
              min={LIMITS.sessionSize.min}
              max={LIMITS.sessionSize.max}
              step={LIMITS.sessionSize.step}
              value={settings.sessionSize}
              onChange={(e) => update({ sessionSize: Number(e.target.value) })}
            />
            <span className="setting-value mono">{settings.sessionSize}</span>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-name">New patterns per session</div>
            <div className="faint">How many fresh patterns a "learn ahead" run introduces.</div>
          </div>
          <div className="setting-control">
            <input
              type="range"
              min={LIMITS.newPerDay.min}
              max={LIMITS.newPerDay.max}
              step={LIMITS.newPerDay.step}
              value={settings.newPerDay}
              onChange={(e) => update({ newPerDay: Number(e.target.value) })}
            />
            <span className="setting-value mono">{settings.newPerDay}</span>
          </div>
        </div>
      </section>

      <section className="settings-card card">
        <h2>Appearance</h2>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-name">Theme</div>
            <div className="faint">Also toggleable from the top bar or ⌘K.</div>
          </div>
          <div className="setting-control">
            <div className="seg-toggle">
              <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>☀ Light</button>
              <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>☾ Dark</button>
            </div>
          </div>
        </div>
      </section>

      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={reset}>Restore defaults</button>
        <a className="btn ghost" href={href("/stats")}>Backup &amp; data →</a>
      </div>
    </div>
  );
}
