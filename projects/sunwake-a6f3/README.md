# Sunwake

**Ride the last light.** An original, momentum-driven distance game about a solar skiff surfing an endless sea of dunes.

Hold to dive into a downhill slope. Release to launch. Thread sun rings, collect light, and turn clean landings into a solar burst. Four illustrated regions cycle across an endless, seeded landscape.

## Play

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Dive | Hold Space or ↓ | Hold the canvas or dive button |
| Soar | Release | Release |
| Solar burst | Shift or ↑ | Burst button when charged |
| Pause / resume | P or Escape | Pause / resume button |
| Start / retry | Space; R after a run | Let’s fly / One more horizon |

- **Voyage:** a fresh course each run, sunlight management, personal records and challenge rewards.
- **Daily flight:** the same course for the same UTC date, with a personal daily record. No online leaderboard or account.
- **Free flight:** unlimited sunlight for practice. Counts toward lifetime flight count and distance, but does not award light, challenges, or competitive records.
- **The hangar:** spend earned light on Manta and Comet. All three skiffs share the same physics.

Progress is stored on this device with `localStorage`. If browser storage is blocked, the game still works for the current session. Audio starts only after a gesture and can be muted. The game pauses on focus loss and follows the system’s reduced-motion preference.

## Develop

```sh
pnpm install
pnpm dev
```

The production build uses relative asset URLs and needs no external runtime services, font requests, images, or audio downloads. Fonts and their OFL licenses are bundled in `public/fonts`. Artwork is drawn with canvas and static SVG; audio is synthesized with Web Audio.

## Verify

From this folder:

```sh
pnpm lint
pnpm build
node qa/engine-check.mjs
node --test tests/progress.test.mjs
```

Engine checks require Node 24+ native TypeScript support. They cover stable results at 30/60/144 Hz, seeded courses, input transitions, collision grace, charge use, attainable airtime, and bounded effects during long runs. Progress checks cover malformed saves, unavailable storage, reward eligibility, daily records, and practice isolation.

For browser checks, install a Playwright Chromium browser (`pnpm exec playwright install chromium`) and serve the built app with `pnpm preview --host 127.0.0.1 --port 4179`. Then:

```sh
SUNWAKE_URL=http://127.0.0.1:4179 node qa/browser-check.mjs
```

Set `CHROMIUM_PATH` if using an existing browser executable. The suite exercises the real canvas loop and React UI, including desktop and touch controls, pause/resume, once-per-run rewards, saved purchases, repeatable daily flights, dialogs, and narrow-screen layouts. Local screenshots are ignored under `qa/artifacts/`.

The exact repository publishing gate, from the repository root:

```sh
node scripts/verify-project.mjs sunwake-a6f3
```

## Code map

- `src/game/engine.ts`: fixed-timestep physics, terrain, seeded pickups and hazards, collision handling, and scoring.
- `src/game/renderer.ts`: layered landscapes, skiffs, effects, region transitions, and the personal-best flag.
- `src/game/progress.ts`: validated saves, challenges, daily seeds, and cosmetic unlocks.
- `src/game/audio.ts`: gesture-unlocked wind, ambient tones, and event sounds.
- `src/App.tsx`: menus, input, HUD, results, accessibility, and persistence integration.
- `JOURNAL.md`: design decisions, shipped work, and future ideas.
