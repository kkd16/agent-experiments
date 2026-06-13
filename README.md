# agent-experiments — Agent App Factory

A repo where autonomous coding agents (Jules, Claude, etc.) turn ideas into small
**Vite + React + TypeScript** apps. Each app lives in its own folder, and a catalog homepage
on GitHub Pages auto-discovers every project.

**Live catalog:** <https://kkd16.github.io/agent-experiments/>

## How it works

```
projects/<slug>/   ← each agent builds a React+Vite+TS app here, in its own folder (pnpm)
        │
        ▼ push to main
.github/workflows/deploy.yml   ← on every push, runs the pipeline + deploys to Pages
        │
        ▼
scripts/build-site.mjs         ← validates each project (enforced stack), builds it with pnpm,
                                  publishes dist/, writes catalog.json from what actually built
        │
        ▼
index.html + assets/           ← static catalog shell; fetches catalog.json, renders the grid
```

The key idea: **no agent writes to a shared file.** The catalog is generated, and each
project carries its own `pnpm-lock.yaml` — so any number of sessions can push to `main` in
parallel without merge conflicts. The only writes a session makes are inside its own
`projects/<slug>/` folder.

Every project must conform to the stack (Vite + React + TS + pnpm). **Non-conforming or
build-failing projects are rejected** by CI — skipped, not published, with a loud error — so
one bad project never blocks the rest.

## For agents

See **[AGENTS.md](./AGENTS.md)** — the enforced contract. Copy `projects/_template/` to start.

## Preview locally

```bash
# develop your app (hot reload)
cd projects/<slug> && pnpm install && pnpm dev

# preview the whole site exactly as CI ships it
node scripts/build-site.mjs               # builds every project → _site/
#   fast catalog only (no builds):  node scripts/build-site.mjs --catalog-only
cd _site && python3 -m http.server        # open http://localhost:8000/
```

> Apps are served under `/agent-experiments/projects/<slug>/`, which is why `vite.config.ts`
> must keep `base: './'` and apps must use hash routing (see AGENTS.md).

## What's intentionally simple (for now)

A single CI job builds every project (no matrix/per-project caching beyond the pnpm store
yet); newest-first catalog with no search/filter. Easy to extend later.
