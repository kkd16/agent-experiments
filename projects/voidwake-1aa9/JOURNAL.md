# Voidwake — The Last Signal

A single-player space roguelite: command a small crew through three procedurally connected sectors, build a tactical card deck, and discover the source of a mysterious transmission. This is an entirely local game with no accounts or external services.

## Design and architecture

- Observatory instruments and expedition cartography: midnight navy, weathered steel, amber signals, mist teal, and muted lavender. A branching star chart with a planet on its horizon anchors the bridge.
- Barlow Condensed display, DM Sans body, IBM Plex Mono instruments; fonts are bundled locally. Ships, portraits, map symbols, and the catalog thumbnail are original SVG assets.
- `src/game.ts` is a deterministic, immutable state machine. `src/content.ts` holds cards, ships, sectors, crew, artifacts, and narrative encounters. `src/App.tsx` provides navigation and all game phases. `src/Art.tsx` contains vector artwork. `src/audio.ts` synthesizes optional sound effects.
- Seeds normalize to uppercase. Campaigns save after each action in `voidwake-1aa9-save-v1`; malformed saves fall back safely. Best completed-run score is retained separately. If storage fails, play continues with a visible warning.
- Each sector has an arrival point, five columns of three destinations, and a guardian. Every route reaches its guardian. Gate transit adds 6 fuel and repairs 25 hull. Emergency fuel prevents a stranded campaign.
- Combat draws five cards, refills three energy, and resets passive shields per turn. Crew share one ability use per battle. Burn resolves before enemy intent; vulnerable increases damage by 50%; exhaust lasts one battle. Explorer reduces enemy stats and adds post-battle repairs. Captain removes that assistance.

## Shipped

- [x] Three complete sectors, seeded maps, branching routes, and guardian battles.
- [x] Three playable ships with distinct starting decks and passive statistics.
- [x] Eighteen combat systems, enhanced variants, energy, shields, burn, vulnerability, evade, draw/discard/exhaust piles, and enemy intent patterns.
- [x] Three crew abilities, illustrated portraits, trust, and a trust-dependent ending.
- [x] Six narrative encounters with eighteen resource-sensitive decisions.
- [x] Six persistent artifacts, elite rewards, salvage, and a ship upgrade economy.
- [x] Stations with repairs, refueling, permanent upgrades, card purchases, enhancement, and removal.
- [x] Victory, defeat, six milestones, campaign scores, best score, and a captain's log.
- [x] Automatic saves, validation, save recovery, sound toggle, keyboard shortcuts, native accessible dialogs, mobile layouts, and reduced-motion support.
- [x] Custom static SVG catalog thumbnail and favicon.
- [x] Meaningful engine regression tests and automated complete-campaign simulations.
- [x] Production-subpath browser campaign, desktop/mobile screenshots, keyboard controls, save recovery, storage failure handling, and zero console/network failures.
- [ ] Explore additional enemy silhouettes and more sector-specific story encounters in a future iteration.
- [ ] Consider a challenge mode with daily shared seeds and limited resupply.

## Verification

- `pnpm test` uses Node 24's TypeScript support and built-in test runner. Tests cover map reachability, all card variants, legal actions, deck conservation, combat status effects, shops, story affordability, terminal states, and save round trips. A deterministic pilot completes 36 campaigns across all ships and both difficulties without modifying their game state.
- `pnpm build` and `pnpm lint` are unchanged template scripts.
- `pnpm test:browser` uses Playwright Chromium and serves the production build under `/agent-experiments/projects/voidwake-1aa9/`. Install Chromium with `pnpm exec playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing compatible Chromium binary. Screenshots stay in ignored `tests/artifacts/`.
- The publication gate is `node scripts/verify-project.mjs voidwake-1aa9` from the repository root.

## Session log

- 2026-09-24 (codex / gpt-6): Created Voidwake from the required template; implemented the complete three-sector campaign, custom visual identity, responsive command bridge, persistence, and regression coverage. All work is contained in this project folder.

- 2026-09-24 validation: 16 engine tests passed; 36 complete campaigns exercised 2,480 actions; a 59-action browser campaign reached victory; the exact publication gate passed scope, conformance, frozen install, lint, build, and static-thumbnail/subpath validation.
