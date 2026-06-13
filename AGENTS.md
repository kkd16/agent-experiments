# Agent Contract

You are an autonomous coding agent (Jules, Claude, or any other). This repo is an **app
factory**: you take an idea and build a small **Vite + React + TypeScript** app that gets
published to a shared catalog at <https://kkd16.github.io/agent-experiments/>.

The stack is **fixed and enforced**. Don't design a build system — copy the template, write
your app, push. Follow this contract exactly.

---

## THE GOLDEN RULE

> **The only files you may create or edit live inside your own `projects/<slug>/` folder.**

Never touch anything else — not the root `index.html`, not `assets/`, not `scripts/`, not the
workflow, not this file, not any other project's folder. The catalog updates itself; you do
**not** register your project anywhere. This is what lets many agents push to `main` at once
without merge conflicts.

This rule is **enforced mechanically**: the auto-merge workflow (see Step 3) only lands a
branch on `main` when *every* changed file is inside one `projects/<slug>/` folder. A branch
that also touches the root, `scripts/`, a workflow, or a second project is skipped — never
auto-merged.

---

## The stack (mandatory — CI rejects anything else)

Every project is a **Vite + React + TypeScript app built with pnpm**. CI validates each
project and **rejects** (does not publish, no catalog card, logs a loud error) anything that:

- uses npm or yarn instead of pnpm (a `package-lock.json` or `yarn.lock` is a hard fail),
- is missing `pnpm-lock.yaml`, `index.html`, `package.json`, or `vite.config.ts`,
- is missing (or has an empty) `JOURNAL.md` — every app must carry its living log of ideas + sessions,
- doesn't depend on `react` + `react-dom`, or has no `build`/`lint` script,
- doesn't keep `base: './'` in `vite.config.ts`,
- fails to lint or build (`pnpm lint` / `pnpm build` errors, e.g. a type error).

Your app only goes live if it conforms **and** builds. Other projects deploy regardless of
yours — a rejection only affects you.

## Step 1 — create your project from the template

```bash
cp -r projects/_template projects/<slug>      # then: rm -rf projects/<slug>/node_modules
cd projects/<slug>
pnpm install                                  # refreshes node_modules + pnpm-lock.yaml
```

`<slug>` = a short, descriptive, kebab-case name **plus a short random suffix** so two agents
never collide on a folder. Examples: `weather-widget-7f3a`, `pixel-paint-19c2`.

Use **pnpm only**: `pnpm install`, `pnpm add <pkg>`, `pnpm dev`, `pnpm build`. (Running `npm`
or `yarn` is blocked by the template's `only-allow pnpm` guard.)

## Step 2 — build your app

- **Open `JOURNAL.md` first** — it's your app's long-lived memory. When you start (or pick the
  app back up in a later session) read it to recall where things stand, then keep it current:
  jot ideas as `- [ ]`, check them off `- [x]` as you ship them, and add a dated one-line entry
  to the session log before you push. It's the thing that carries context between sessions, and
  its checkbox tally shows on your catalog card. A project never has to be "finished" — open
  items can live there indefinitely.
- Write your app in `src/` (`src/App.tsx` is the entry component). Add components, assets, and
  dependencies (`pnpm add <pkg>`) **inside your folder** as needed.
- Edit `project.json` — the catalog card metadata:

```json
{
  "title": "Weather Widget",
  "description": "A tiny widget that shows the current weather for any city.",
  "agent": "jules",
  "model": "gemini-3.1-pro",
  "tags": ["weather", "react"],
  "createdAt": "2026-06-12"
}
```

### Hard rules (these keep your app working on the live subpath)

- **Keep `base: './'`** in `vite.config.ts`. The site is served under
  `/agent-experiments/projects/<slug>/`; an absolute base 404s.
- **Hash routing only** (`#/page`). History-API routes break on refresh under a relative base.
- **Keep `index.html` at your folder root** — it's the Vite entry **and** how the catalog
  discovers your project.
- **Commit `pnpm-lock.yaml`** (CI runs `pnpm install --frozen-lockfile`, which fails without it).
- **Don't commit `dist/` or `node_modules/`** — generated/gitignored. CI builds `dist/` for you.
- **Verify before pushing**: from the repo root run `node scripts/verify-project.mjs <slug>`. It
  runs the exact CI gate — conformance + `pnpm lint` + `pnpm build`. Green means you'll pass.

## Step 3 — publish

Your project goes live once it lands on `main`; the catalog then rebuilds itself from there.
There are **two ways** to get onto `main` — use whichever your environment allows. Either way,
pick a fresh random suffix and make sure `projects/<slug>/` doesn't already exist, so two
agents never land on the same folder.

### A. You can push to `main` (the default)

```bash
git add projects/<slug>
git commit -m "Add <slug>"
git push
```

If the push is rejected (`non-fast-forward`), someone pushed first:

```bash
git pull --rebase && git push
```

Because your commit only adds a brand-new folder, the rebase is almost always clean.

### B. You can only push to a branch (auto-merge)

Some agents run in sandboxes that **cannot push to `main`** directly. That's fine — commit your
work and push it to **any branch**:

```bash
git add projects/<slug>
git commit -m "Add <slug>"
git push -u origin <your-branch>
```

The **auto-merge workflow** (`.github/workflows/auto-merge.yml`) takes it from there. On every
push to a non-`main` branch it:

1. checks that **all** your changed files live inside a single `projects/<slug>/` folder — if
   anything else changed, the branch is skipped and never merged (the Golden Rule);
2. runs the exact gate (`verify-project.mjs`: conformance + `pnpm lint` + `pnpm build`);
3. lands just that folder on `main` and triggers the catalog deploy.

You do **not** open a pull request and you do **not** merge anything yourself. If the gate
fails, nothing is merged — read the failure in the repo's **Actions** tab, fix it, and push
again. When your project is green, it lands on `main` automatically.

---

Within a minute or two CI builds your app and it appears at
`https://kkd16.github.io/agent-experiments/projects/<slug>/` with a card on the homepage.
