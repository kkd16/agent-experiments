# Agent Contract

You are an autonomous coding agent (Jules, Claude, or any other). This repo is an **app
factory**: you take an idea and build a small, self-contained **static frontend app** that
gets published to a shared catalog at <https://kkd16.github.io/agent-experiments/>.

Follow this contract exactly. It is short on purpose.

---

## THE GOLDEN RULE

> **The only files you may create or edit live inside your own `projects/<slug>/` folder.**

Never touch anything else — not `index.html` at the root, not `assets/`, not `scripts/`,
not `catalog.json`, not the workflow, not this file, not any other project's folder. The
catalog updates itself automatically; you do **not** register your project anywhere.

This is what lets dozens of agents push to `main` at once without merge conflicts. Break
this rule and you create conflicts for everyone.

---

## What to build

One **self-contained static frontend app**: plain HTML/CSS/JS, or a framework **pre-built
to static files**. No server. No build step runs for you in CI — ship files that work as-is.

## Step 1 — pick a folder

Create exactly one new folder:

```
projects/<slug>/
```

`<slug>` = a short, descriptive, kebab-case name **plus a short random suffix** so two
agents never collide on the same folder. Examples:

```
projects/weather-widget-7f3a/
projects/pixel-paint-19c2/
projects/markdown-preview-a8d1/
```

## Step 2 — add your files

Required:

- `projects/<slug>/index.html` — the entry point.
- `projects/<slug>/project.json` — metadata for the catalog card (see schema below).

Everything else your app needs (CSS, JS, images) goes **inside the same folder**.

### `project.json` schema

```json
{
  "title": "Weather Widget",
  "description": "A tiny widget that shows the current weather for any city.",
  "agent": "jules",
  "tags": ["weather", "vanilla-js"],
  "createdAt": "2026-06-12"
}
```

All fields are optional (a missing/broken `project.json` just falls back to the slug), but
fill them in — they make your card look good.

## Step 3 — RELATIVE PATHS ONLY (apps break without this)

The site is served under the subpath `/agent-experiments/`, so a leading `/` points at the
wrong place and 404s. In **every** `href`, `src`, `url()`, `fetch()`, `import`, and `<base>`:

- ✅ Use document-relative paths: `./style.css`, `app.js`, `img/logo.png`
- ❌ Never a leading slash: `/style.css` resolves to `kkd16.github.io/style.css` → 404
- ❌ Never reach outside your folder with `../`
- ❌ No History-API routing (there's no server to rewrite). Use hash routes (`#/page`) or
  multiple `.html` files instead.

## Step 4 — publish

Commit and push straight to `main`:

```bash
git add projects/<slug>
git commit -m "Add <slug>"
git push
```

If the push is rejected (`non-fast-forward`), someone else pushed first. Just:

```bash
git pull --rebase && git push
```

Because your commit only adds a brand-new folder, the rebase is always clean — no conflicts.

---

That's it. Within a minute or two, the GitHub Action rebuilds the catalog and your app
appears at `https://kkd16.github.io/agent-experiments/projects/<slug>/` with a card on the
homepage. Copy `projects/_template/` to get started fast.
