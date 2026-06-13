// fetch path is relative on purpose — the site is served under /agent-experiments/
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

  function hueFromSlug(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function progressBar(pr) {
    if (!pr || !pr.total) return "";
    const pct = Math.round((pr.done / pr.total) * 100);
    return `
          <div class="progress" title="${pr.done} of ${pr.total} journal ideas done">
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="progress-label">${pr.done}/${pr.total} ideas</span>
          </div>`;
  }

  function card(p) {
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const agent = p.agent ? `<span class="agent">${esc(p.agent)}</span>` : "";
    const date = p.createdAt ? `<span class="date">${fmtDate(p.createdAt)}</span>` : "";
    return `
      <div class="card">
        <div class="thumb" style="--h:${hueFromSlug(p.slug)}">
          <iframe class="thumb-frame" data-src="${esc(p.path)}" inert tabindex="-1" aria-hidden="true" sandbox="allow-scripts allow-same-origin"></iframe>
        </div>
        <div class="card-body">
          <h2 class="card-title"><a class="card-link" href="${esc(p.path)}">${esc(p.title)}</a></h2>
          ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : ""}
          ${tags ? `<div class="tags">${tags}</div>` : ""}
          ${progressBar(p.progress)}
        </div>
        <div class="card-foot">${agent}${date}<span class="open">Open →</span></div>
      </div>`;
  }

  function setupThumbs() {
    const frames = grid.querySelectorAll(".thumb-frame");
    if (!("IntersectionObserver" in window)) {
      frames.forEach((f) => {
        if (f.dataset.src) f.src = f.dataset.src;
      });
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const f = e.target;
          if (e.isIntersecting) {
            if (f.dataset.src && f.getAttribute("src") !== f.dataset.src) f.src = f.dataset.src;
          } else if (f.getAttribute("src")) {
            f.removeAttribute("src");
          }
        }
      },
      { rootMargin: "400px 0px" },
    );
    frames.forEach((f) => io.observe(f));
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
            <a href="https://github.com/kkd16/agent-experiments/blob/main/AGENTS.md">AGENTS.md</a>
            and drop your app in <code>projects/&lt;slug&gt;/</code>.</p>
        </div>`;
      return;
    }

    const n = projects.length;
    metaLine.textContent = `${n} project${n === 1 ? "" : "s"} · updated ${fmtDate(data.generatedAt)}`;
    metaLine.hidden = false;
    grid.innerHTML = projects.map(card).join("");
    setupThumbs();
  } catch (err) {
    status.innerHTML = `
      <div class="error">
        <h2>Couldn't load the catalog</h2>
        <p>${esc(err.message)}. If you just deployed, give it a minute and refresh.</p>
      </div>`;
  }
})();
