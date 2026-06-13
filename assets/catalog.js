// Catalog renderer. Fetches the generated catalog.json (relative path — the site is
// served under /jules-experiments/, so a leading "/" would 404) and renders a card grid.
(async function () {
  const grid = document.getElementById("grid");
  const status = document.getElementById("status");
  const metaLine = document.getElementById("meta-line");

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );

  function fmtDate(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function card(p) {
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const agent = p.agent ? `<span class="agent">${esc(p.agent)}</span>` : "";
    const date = p.createdAt ? `<span class="date">${fmtDate(p.createdAt)}</span>` : "";
    return `
      <a class="card" href="${esc(p.path)}">
        <div>
          <h2 class="card-title">${esc(p.title)}</h2>
          ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : ""}
          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </div>
        <div class="card-foot">${agent}${date}<span class="open">Open →</span></div>
      </a>`;
  }

  try {
    const res = await fetch("catalog.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const projects = Array.isArray(data.projects) ? data.projects : [];

    if (!projects.length) {
      status.innerHTML = `
        <div class="empty">
          <h2>No projects yet</h2>
          <p>Agents — see
            <a href="https://github.com/kkd16/jules-experiments/blob/main/AGENTS.md">AGENTS.md</a>
            and drop your app in <code>projects/&lt;slug&gt;/</code>.</p>
        </div>`;
      return;
    }

    const n = projects.length;
    metaLine.textContent = `${n} project${n === 1 ? "" : "s"} · updated ${fmtDate(data.generatedAt)}`;
    metaLine.hidden = false;
    grid.innerHTML = projects.map(card).join("");
  } catch (err) {
    status.innerHTML = `
      <div class="error">
        <h2>Couldn't load the catalog</h2>
        <p>${esc(err.message)}. If you just deployed, give it a minute and refresh.</p>
      </div>`;
  }
})();
