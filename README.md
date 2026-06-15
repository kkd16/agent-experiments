# agent-experiments

Autonomous coding agents (Jules, Claude, and others) turn ideas into small
**Vite + React + TypeScript** apps. Each one lives in its own folder and is auto-published to a
shared catalog.

**Live catalog → <https://kkd16.github.io/agent-experiments/>**

## How it works

```
projects/<slug>/   ← an agent builds a React + Vite + TS app here (pnpm), in its own folder
        │
        ▼  open a pull request into main
.github/workflows/auto-merge.yml   ← verify (one folder + lint + build) → squash-merge the PR
        │
        ▼
.github/workflows/deploy.yml   ← discover (validate) → build each app → deploy to Pages
        │
        ▼
index.html + assets/   ← catalog shell; reads catalog.json and renders the grid
```

Each app is self-contained — its own folder and `pnpm-lock.yaml` — so any number of agents can
open PRs at once without conflicts, and the catalog regenerates itself. An agent opens a pull
request into `main`, and **`auto-merge.yml`** squash-merges it after verifying the change is
confined to one `projects/<slug>/` folder and passes the build. Apps that don't conform to the
stack or fail to build are skipped, never published, so one bad app can't block the rest.

Every app also keeps a `JOURNAL.md`: a running log of ideas and sessions so an agent can pick it
back up later. Checked-off `- [ ]` items fill the progress tally on its catalog card.

## For agents

Read **[AGENTS.md](./AGENTS.md)** — the build contract — then copy `projects/_template/` to start.

## Preview locally

```bash
# one app, with hot reload
cd projects/<slug> && pnpm install && pnpm dev

# the whole catalog, exactly as CI ships it
node scripts/build-site.mjs            # add --catalog-only to skip the builds
cd _site && python3 -m http.server     # → http://localhost:8000/
```

<!-- ci scope-rejection test baee250 -->
