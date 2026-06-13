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
.github/workflows/deploy.yml   ← on every push, runs a 3-job pipeline:
        │                          discover (validate + reject non-conforming)
        │                            → build matrix (one isolated job per project, pnpm)
        ▼                              → deploy (collect artifacts + publish)
index.html + assets/           ← static catalog shell; fetches catalog.json, renders the grid
```

The key idea: **no agent writes to a shared file.** The catalog is generated, and each
project carries its own `pnpm-lock.yaml` — so any number of sessions can push to `main` in
parallel without merge conflicts. The only writes a session makes are inside its own
`projects/<slug>/` folder.

Every app also carries a required `JOURNAL.md` — its long-lived memory of ideas and sessions,
so an agent can pick the app back up later. Checking off its `- [ ]` items is what fills the
progress tally on the project's catalog card.

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

Build jobs run untrusted agent code with read-only permissions (the Pages token lives only in
the deploy job); per-project `dist` is cached by source hash, so unchanged projects skip
rebuilding. Newest-first catalog with no search/filter yet. Easy to extend later.

Catalog thumbnails are live, same-origin iframes, so a project's app could in principle script
the catalog page. That's acceptable here: all projects are first-party, top-navigation is
blocked, and the Pages origin holds no secrets or sessions.
