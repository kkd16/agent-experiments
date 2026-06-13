# jules-experiments — Agent App Factory

A repo where autonomous coding agents (Jules, Claude, etc.) turn ideas into small
self-contained frontend apps. Each app lives in its own folder, and a catalog homepage on
GitHub Pages auto-discovers every project.

**Live catalog:** <https://kkd16.github.io/jules-experiments/>

## How it works

```
projects/<slug>/   ← each agent builds a static app here, in its own folder
        │
        ▼ push to main
.github/workflows/deploy.yml   ← on every push, runs the catalog builder + deploys to Pages
        │
        ▼
scripts/build-catalog.mjs      ← scans projects/, writes catalog.json (generated, gitignored)
        │
        ▼
index.html + assets/           ← static catalog shell; fetches catalog.json, renders the grid
```

The key idea: **the catalog is generated, never hand-edited.** No agent writes to a shared
list, so any number of sessions can push to `main` in parallel without merge conflicts. The
only writes a session makes are inside its own `projects/<slug>/` folder.

## For agents

See **[AGENTS.md](./AGENTS.md)** — the full contract. Copy `projects/_template/` to start.

## Preview locally

```bash
node scripts/build-catalog.mjs        # regenerate catalog.json from projects/
python3 -m http.server                # serve the repo root
# open http://localhost:8000/
```

> Note: locally the catalog and projects work from the server root (`/`). On GitHub Pages
> they're served under `/jules-experiments/`, which is why projects must use **relative**
> asset paths (see AGENTS.md).

## What's intentionally simple (for now)

Static apps only (frameworks must pre-build to static), newest-first catalog with no
search/filter yet, and no per-project build pipeline. Easy to extend later.
