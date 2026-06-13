(function () {
  const $ = (id) => document.getElementById(id);
  const grid = $("grid");
  const statusEl = $("status");
  const statsEl = $("stats");
  const toolbar = $("toolbar");
  const facetsEl = $("facets");
  const qInput = $("q");
  const sortSel = $("sort");
  const viewSeg = $("view");
  const themeBtn = $("theme");
  const countEl = $("count");
  const clearBtn = $("clear");
  const statusbarEl = $("statusbar");
  const filtersEl = $("filters");
  const filtersBtn = $("filtersBtn");
  const filtersPop = $("filtersPop");
  const filtersBadge = $("filtersBadge");

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  const fmtDate = (s) => {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d.getTime())) return esc(s);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };
  const hueFromSlug = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  const state = { all: [], q: "", tags: new Set(), agent: "", status: "all", sort: "new", view: "grid" };
  let io = null;
  let firstPaint = true;

  const shipped = (p) => p.progress && p.progress.total > 0 && p.progress.done === p.progress.total;
  const active = (p) => p.progress && p.progress.total > 0 && p.progress.done < p.progress.total;
  const filtered = () => state.q || state.tags.size || state.agent || state.status !== "all";

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    themeBtn.textContent = t === "dark" ? "☾" : "☀";
    try {
      localStorage.setItem("catalog-theme", t);
    } catch {}
  }

  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    state.q = h.get("q") || "";
    state.tags = new Set((h.get("tags") || "").split(",").filter(Boolean));
    state.agent = h.get("agent") || "";
    state.status = h.get("status") || "all";
    state.sort = h.get("sort") || "new";
    state.view = h.get("view") === "list" ? "list" : "grid";
  }

  function writeHash(replace) {
    const h = new URLSearchParams();
    if (state.q) h.set("q", state.q);
    if (state.tags.size) h.set("tags", [...state.tags].join(","));
    if (state.agent) h.set("agent", state.agent);
    if (state.status !== "all") h.set("status", state.status);
    if (state.sort !== "new") h.set("sort", state.sort);
    if (state.view !== "grid") h.set("view", state.view);
    const str = h.toString();
    const url = location.pathname + location.search + (str ? "#" + str : "");
    history[replace ? "replaceState" : "pushState"](null, "", url);
  }

  const commit = (replace = false) => {
    writeHash(replace);
    render();
  };

  function syncControls() {
    if (document.activeElement !== qInput) qInput.value = state.q;
    sortSel.value = state.sort;
    [...viewSeg.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  }

  function derive() {
    const q = state.q.trim().toLowerCase();
    const list = state.all.filter((p) => {
      if (state.agent && p.agent !== state.agent) return false;
      if (state.tags.size && ![...state.tags].some((t) => (p.tags || []).includes(t))) return false;
      if (state.status === "shipped" && !shipped(p)) return false;
      if (state.status === "active" && !active(p)) return false;
      if (q) {
        const hay = `${p.title} ${p.description} ${p.agent} ${p.model} ${(p.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const pct = (p) => (p.progress && p.progress.total ? p.progress.done / p.progress.total : -1);
    const byNew = (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || a.slug.localeCompare(b.slug);
    if (state.sort === "old") list.sort((a, b) => -byNew(a, b));
    else if (state.sort === "az") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (state.sort === "prog") list.sort((a, b) => pct(b) - pct(a) || byNew(a, b));
    else list.sort(byNew);
    return list;
  }

  function ring(p) {
    const pr = p.progress;
    if (!pr || !pr.total) return "";
    const pct = Math.round((pr.done / pr.total) * 100);
    return `<div class="ring" style="--pct:${pct}" title="${pr.done} of ${pr.total} journal ideas done"><span>${pr.done}/${pr.total}</span></div>`;
  }

  function card(p, i) {
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const agent = p.agent ? `<span class="agent">${esc(p.agent)}</span>` : "";
    const model = p.model ? `<span class="model" title="Built with ${esc(p.model)}">${esc(p.model)}</span>` : "";
    const date = p.createdAt ? `<span class="date">${fmtDate(p.createdAt)}</span>` : "";
    return `
      <article class="card" style="animation-delay:${Math.min(i, 12) * 45}ms">
        <div class="thumb" style="--h:${hueFromSlug(p.slug)}">
          <iframe class="thumb-frame" data-src="${esc(p.path)}" inert tabindex="-1" aria-hidden="true" sandbox="allow-scripts allow-same-origin"></iframe>
          <span class="open-badge" aria-hidden="true">↗</span>
        </div>
        <div class="card-body">
          <h2 class="card-title"><a class="card-link" href="${esc(p.path)}">${esc(p.title)}</a></h2>
          ${p.description ? `<p class="card-desc">${esc(p.description)}</p>` : ""}
          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </div>
        <div class="card-foot">${agent}${model}${date}<span class="foot-spacer"></span>${ring(p)}</div>
      </article>`;
  }

  function renderFacets() {
    const tagCount = {};
    const agentCount = {};
    for (const p of state.all) {
      (p.tags || []).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1));
      if (p.agent) agentCount[p.agent] = (agentCount[p.agent] || 0) + 1;
    }
    const byCount = (m) => (a, b) => m[b] - m[a] || a.localeCompare(b);
    const tags = Object.keys(tagCount).sort(byCount(tagCount));
    const agents = Object.keys(agentCount).sort(byCount(agentCount));
    const chip = (kind, val, label, on, n) =>
      `<button type="button" class="chip" data-kind="${kind}" data-val="${esc(val)}" aria-pressed="${on}">${esc(label)}${n != null ? `<span class="n">${n}</span>` : ""}</button>`;

    statusbarEl.innerHTML = [["all", "All"], ["active", "In progress"], ["shipped", "Shipped"]]
      .map(([v, l]) => chip("status", v, l, state.status === v))
      .join("");

    const group = (label, chips) =>
      `<div class="facet-group"><span class="facet-label">${label}</span><div class="facet-chips">${chips}</div></div>`;
    let html = "";
    if (tags.length) html += group("tags", tags.map((t) => chip("tag", t, t, state.tags.has(t), tagCount[t])).join(""));
    if (agents.length > 1) html += group("agent", agents.map((a) => chip("agent", a, a, state.agent === a, agentCount[a])).join(""));
    facetsEl.innerHTML = html;
    filtersEl.hidden = html === "";

    const n = state.tags.size + (state.agent ? 1 : 0);
    filtersBadge.textContent = String(n);
    filtersBadge.hidden = n === 0;
  }

  function renderStats() {
    const apps = state.all.length;
    const agents = new Set(state.all.map((p) => p.agent).filter(Boolean)).size;
    const ideas = state.all.reduce((s, p) => s + ((p.progress && p.progress.done) || 0), 0);
    statsEl.innerHTML =
      `<div class="stat"><b>${apps}</b><span>apps</span></div>` +
      `<div class="stat"><b>${agents}</b><span>agents</span></div>` +
      `<div class="stat"><b>${ideas}</b><span>ideas shipped</span></div>`;
    statsEl.hidden = false;
  }

  function setupThumbs() {
    if (io) io.disconnect();
    const frames = grid.querySelectorAll(".thumb-frame");
    if (!("IntersectionObserver" in window)) {
      frames.forEach((f) => {
        if (f.dataset.src) f.src = f.dataset.src;
      });
      return;
    }
    io = new IntersectionObserver(
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

  function clearAll() {
    state.q = "";
    state.tags = new Set();
    state.agent = "";
    state.status = "all";
    commit();
  }

  function render() {
    syncControls();
    renderFacets();
    const list = derive();
    const intro = firstPaint && list.length;
    grid.className = "grid" + (state.view === "list" ? " list" : "") + (intro ? " intro" : "");
    if (!list.length) {
      grid.innerHTML = "";
      statusEl.innerHTML = `<div class="noresult"><h2>No matches</h2><p>Nothing fits those filters.</p><button type="button" class="clear" data-clear>Clear filters ✕</button></div>`;
    } else {
      statusEl.innerHTML = "";
      grid.innerHTML = list.map(card).join("");
      setupThumbs();
    }
    if (intro) {
      firstPaint = false;
      setTimeout(() => grid.classList.remove("intro"), 900);
    }
    countEl.textContent = `${list.length} of ${state.all.length} app${state.all.length === 1 ? "" : "s"}`;
    clearBtn.hidden = !filtered();
  }

  qInput.addEventListener(
    "input",
    debounce(() => {
      state.q = qInput.value;
      commit(true);
    }, 120),
  );
  sortSel.addEventListener("change", () => {
    state.sort = sortSel.value;
    commit();
  });
  viewSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.view = b.dataset.view;
    commit();
  });
  themeBtn.addEventListener("click", () =>
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"),
  );
  function onChip(e) {
    const b = e.target.closest(".chip");
    if (!b) return;
    const { kind, val } = b.dataset;
    if (kind === "tag") state.tags.has(val) ? state.tags.delete(val) : state.tags.add(val);
    else if (kind === "agent") state.agent = state.agent === val ? "" : val;
    else if (kind === "status") state.status = val;
    commit();
    const sel = `.chip[data-kind="${kind}"][data-val="${CSS.escape(val)}"]`;
    (filtersPop.querySelector(sel) || statusbarEl.querySelector(sel))?.focus({ preventScroll: true });
  }
  statusbarEl.addEventListener("click", onChip);
  facetsEl.addEventListener("click", onChip);

  function openFilters(open) {
    filtersPop.hidden = !open;
    filtersBtn.setAttribute("aria-expanded", String(open));
  }
  filtersBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openFilters(filtersPop.hidden);
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) {
      clearAll();
      return;
    }
    if (!filtersEl.contains(e.target)) openFilters(false);
  });
  const rehydrate = () => {
    readHash();
    render();
  };
  window.addEventListener("popstate", rehydrate);
  window.addEventListener("hashchange", rehydrate);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !filtersPop.hidden) {
      openFilters(false);
      filtersBtn.focus();
      return;
    }
    const typing = /^(input|textarea|select)$/i.test(document.activeElement.tagName || "");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      qInput.focus();
    } else if (e.key === "Escape" && document.activeElement === qInput) {
      state.q = "";
      qInput.value = "";
      qInput.blur();
      commit(true);
    } else if (!typing && (e.key === "g" || e.key === "l")) {
      state.view = e.key === "g" ? "grid" : "list";
      commit();
    }
  });

  let theme = "dark";
  try {
    theme = localStorage.getItem("catalog-theme") || "dark";
  } catch {}
  applyTheme(theme);

  (async () => {
    try {
      const res = await fetch("catalog.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.all = Array.isArray(data.projects) ? data.projects : [];
      if (!state.all.length) {
        statusEl.innerHTML = `<div class="empty"><h2>No apps yet</h2><p>Agents — see <a href="https://github.com/kkd16/agent-experiments/blob/main/AGENTS.md">AGENTS.md</a> and drop your app in <code>projects/&lt;slug&gt;/</code>.</p></div>`;
        return;
      }
      readHash();
      renderStats();
      toolbar.hidden = false;
      render();
    } catch (err) {
      statusEl.innerHTML = `<div class="error"><h2>Couldn't load the catalog</h2><p>${esc(err.message)}. If you just deployed, give it a minute and refresh.</p></div>`;
    }
  })();
})();
