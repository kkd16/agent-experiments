# Sunwake

**Ride the last light.** An original, momentum-driven distance game about a solar skiff surfing an endless sea of dunes.

Hold to dive into a downhill slope. Release to launch. Thread sun rings, collect light, and turn clean landings into a solar burst. Four illustrated regions bring different dune rhythms across an endless, seeded landscape.

Catch rising thermals, chain three rings for a light magnet, carry a sun shield through danger, and meet downhill slopes gently for perfect landings. Timing matters: skillful dives and well-placed bursts carry you much farther than simply holding a button.

## Play

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Dive | Hold Space or ↓ | Hold the canvas or dive button |
| Soar | Release | Release |
| Solar burst | Shift or ↑ | Burst button when charged |
| Pause / resume | P or Escape | Pause / resume button |
| Start / retry | Space; R while paused or after a run retries the same route | Let’s fly / replay controls |

- **Voyage:** a fresh course each run, sunlight management, personal records and challenge rewards.
- **Daily flight:** the same course for the same UTC date, with a personal daily record. No online leaderboard or account.
- **Free flight:** unlimited sunlight for practice. Counts toward lifetime flight count and distance, but does not award light, challenges, or competitive records.
- **The Sun Atlas:** six finite expeditions with finish beacons, changing flight conditions, and eighteen seals to earn. Reach a destination to unlock the next crossing.
- **The hangar:** spend earned light on Manta and Comet, or earn twelve atlas seals to unlock Kestrel. All four skiffs share the same physics. Choose from five cosmetic wakes as you collect seals.
- **Race this route:** retry the same seed against a translucent replay of your best flight. Ghosts are saved for the four most recent improved courses; Free flight does not create competitive ghosts.
- **Course links:** share the exact landscape with a versioned URL. Recipients race their own local ghosts; the link shares the course, not your saved replay.
- **Flight log:** revisit the last twelve journeys, replay any course, and compare distance, duration, score, and light collected. Historical daily courses replay as Voyage.

The flight guide explains each pickup and lets you switch coaching or ghost visibility off. Your debrief includes a height trace, perfect landings, sky chains, longest glide, top speed, and a tip for the next journey. Sixteen challenges reward progress through the game.

Progress is stored on this device with `localStorage`. Existing Sunwake records, unlocks, and earned light survive the update. If browser storage is blocked, the game and ghost replay still work for the current session. Audio starts only after a gesture and can be muted. The game pauses on focus loss and follows the system’s reduced-motion preference.

Standard controllers also work: hold the bottom face button or right trigger to dive; use the right/left face button or left trigger to burst; Menu pauses/resumes. The bottom face button starts from the welcome screen and retries from results. Releasing one input never cancels another held input. Disconnecting the active controller pauses the flight. Browser support uses the standard Gamepad mapping; a button press may be needed before the browser detects it.

## The Sun Atlas

| Expedition | Distance | Conditions | Finesse seal | Swift seal |
| --- | --- | --- | --- | --- |
| First post | 650 m | Familiar amber dunes | 3 clean landings | 16 s |
| Rose express | 900 m | Steady tailwind | 6 rings | 20 s |
| Glass crossing | 1,100 m | Sunlight fades 25% faster | No hits | 26 s |
| Lantern run | 1,400 m | Start at 60 sunlight; 20% faster drain | 35 sparks | 32 s |
| Updraft alley | 1,700 m | Gentler gravity | 3 thermals | 38 s |
| Last beacon | 2,400 m | Long crossing; 15% faster drain | 12 rings | 52 s |

Each route awards an arrival seal and two optional skill/speed seals. All seals require reaching the finish. You can collect them across separate attempts; each new seal pays 40 light once. Two intermediate beacons restore 12 sunlight each. Route times and seals have their own records; expedition modifiers never affect Voyage/Daily records, missions, or ghosts. Collected sparks still become spendable light.

Three seals unlock the Seafoam wake; six unlock Wild violet; twelve unlock Kestrel and Aurora; all eighteen unlock Stardust. These rewards change appearance only. Existing version-2 course links and ghosts retain their exact physics. Expedition links use a separate `#/expedition/1/<route>` format and open the atlas, where the route's normal unlock requirements apply.

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
node --test tests/*.test.mjs
```

Engine checks require Node 24+ native TypeScript support. They cover stable results at 30/60/144 Hz, seeded courses, input transitions, collision grace, charge use, attainable airtime, continuous terrain transitions, new pickups, and bounded effects during long runs. Progress and replay checks cover old-save migration, malformed saves, unavailable storage, reward eligibility, daily records, practice isolation, shared seeds, interpolation, multi-source input, and bounded hour-long ghost recordings.

For browser checks, install a Playwright Chromium browser (`pnpm exec playwright install chromium`) and serve the built app with `pnpm preview --host 127.0.0.1 --port 4179`. Then:

```sh
SUNWAKE_URL=http://127.0.0.1:4179 node qa/browser-check.mjs
SUNWAKE_URL=http://127.0.0.1:4179 node qa/atlas-check.mjs
```

Set `CHROMIUM_PATH` if using an existing browser executable. The suites exercise the real canvas loop and React UI, including desktop/touch/controller controls, pause/resume, once-per-run rewards, saved purchases, repeatable daily flights, shared courses, ghost accuracy, history replay, preferences, blocked clipboard/storage, expedition arrivals and unlocks, three-seal flights, dialogs, and portrait/landscape layouts. Local screenshots are ignored under `qa/artifacts/`.

The exact repository publishing gate, from the repository root:

```sh
node scripts/verify-project.mjs sunwake-a6f3
```

## Code map

- `src/game/engine.ts`: fixed-timestep physics, terrain, seeded pickups and hazards, collision handling, and scoring.
- `src/game/renderer.ts`: layered landscapes, skiffs, effects, region transitions, and the personal-best flag.
- `src/game/progress.ts`: validated saves, challenges, daily seeds, and cosmetic unlocks.
- `src/game/replay.ts`: versioned course links, bounded recordings, saved ghosts, and interpolation.
- `src/game/input.ts`: independent keyboard/pointer holds and short burst pulses.
- `src/game/audio.ts`: gesture-unlocked wind, ambient tones, and event sounds.
- `src/game/expeditions.ts`: route definitions, conditions, seals, links, unlock rules, and validated atlas records.
- `src/game/cosmetics.ts`: visual wake choices and their unlock thresholds.
- `src/game/controller.ts`: standard gamepad holds, button edges, and disconnect detection.
- `src/Atlas.tsx` / `src/Atlas.css`: illustrated atlas, live objectives, seal results, and wake selection.
- `src/App.tsx`: menus, input, HUD, results, accessibility, and persistence integration.
- `src/FlightExtras.tsx`: flight coaching, route progress, pickup status, and post-flight analysis.
- `JOURNAL.md`: design decisions, shipped work, and future ideas.
