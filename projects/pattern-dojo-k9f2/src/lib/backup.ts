/**
 * Export / import of all Pattern Dojo state so a learner can back up their
 * progress or move it between browsers. We snapshot the known localStorage keys
 * into a single JSON document and restore them atomically. Everything is wrapped
 * in try/catch so a sandboxed catalog thumbnail never throws.
 */

const KEYS = [
  "pattern-dojo:srs:v1",
  "pattern-dojo:streak:v1",
  "pattern-dojo:dojo:v1",
  "pattern-dojo:theme",
];

export interface Backup {
  app: "pattern-dojo";
  version: 1;
  exportedAt: string;
  data: Record<string, unknown>;
}

export function buildBackup(): Backup {
  const data: Record<string, unknown> = {};
  for (const key of KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      try {
        data[key] = JSON.parse(raw);
      } catch {
        data[key] = raw; // plain string (e.g. the theme)
      }
    } catch {
      /* ignore */
    }
  }
  return { app: "pattern-dojo", version: 1, exportedAt: new Date().toISOString(), data };
}

/** Trigger a file download of the current backup. */
export function downloadBackup() {
  try {
    const blob = new Blob([JSON.stringify(buildBackup(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pattern-dojo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

export type ImportResult = { ok: true; keys: number } | { ok: false; error: string };

/** Restore from a parsed backup document, overwriting current state. */
export function restoreBackup(json: unknown): ImportResult {
  try {
    const b = json as Backup;
    if (!b || b.app !== "pattern-dojo" || typeof b.data !== "object" || b.data == null) {
      return { ok: false, error: "Not a Pattern Dojo backup file." };
    }
    let n = 0;
    for (const key of KEYS) {
      if (!(key in b.data)) continue;
      const val = b.data[key];
      try {
        localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
        n++;
      } catch {
        /* ignore quota */
      }
    }
    // Notify every store hook to re-read.
    window.dispatchEvent(new CustomEvent("pd-srs-change"));
    window.dispatchEvent(new CustomEvent("pd-streak-change"));
    window.dispatchEvent(new CustomEvent("pd-dojo-change"));
    window.dispatchEvent(new CustomEvent("pd-theme-change"));
    return { ok: true, keys: n };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read file." };
  }
}

/** Read a File chosen by the user and restore it. */
export function importFromFile(file: File): Promise<ImportResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(restoreBackup(JSON.parse(String(reader.result))));
      } catch {
        resolve({ ok: false, error: "That file isn't valid JSON." });
      }
    };
    reader.onerror = () => resolve({ ok: false, error: "Could not read the file." });
    reader.readAsText(file);
  });
}
