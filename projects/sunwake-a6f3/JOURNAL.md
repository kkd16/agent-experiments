# Sunwake — journal

## Design direction

An original, one-button distance game about a solar skiff surfing an endless dune sea. Its signature is a live, layered landscape: an enormous low sun, painterly dunes, ancient arches, and a tiny turquoise sail leaving a ribbon of light. Dive downhill, release to soar, thread sun rings, and turn graceful landings into a solar burst.

Palette: ink plum #342c40, chalk #faf7f2, sand #f3ba7b, apricot #ef986f, rose #b86783, turquoise #75d8ce. Typography: locally hosted Bricolage Grotesque for the expressive display; DM Sans for controls and reading; monospace for live flight instruments. Layout: restrained warm page chrome, a dominant panoramic playable world, a compact mission strip, and an illustrated journey map. One strong visual moment instead of a dashboard of interchangeable cards.

## Ideas / backlog

- [x] Responsive one-button dune-surfing physics with touch and keyboard controls.
- [x] Illustrated procedural world with four distance-based regions.
- [x] Sparks, rings, clean landings, near misses, and solar bursts.
- [x] Voyage, seeded daily run, and endless practice modes.
- [x] Local records, missions, and earnable cosmetic skiffs.
- [x] Synthesized reactive audio, pause, reduced motion, and fullscreen.
- [x] Browser playtest on desktop and mobile; exact repository CI gate.
- [x] Original static 16:10 catalog thumbnail.
- [x] Prepare and verify a single-project release for the automatic PR publishing workflow.
- [x] Shareable courses and local best-run ghost replays.
- [ ] Future: more skiff silhouettes.

## Session log

- 2026-09-24 (codex / gpt-6): Started Sunwake from the enforced Vite + React + TypeScript template. Planned an original momentum-driven sky-surfing game and a warm panoramic art direction.

## Shipped behavior and decisions

- A fixed 120 Hz simulation keeps the same seed and input consistent on 30/60/144 Hz displays. Hold accelerates down slopes and dives in air; release launches the skiff, and an open sail floats off dune crests.
- Sunlight depletes during Voyage/Daily and refills from pickups and clean landings. Rocks and electric storms take sunlight with a grace period. A 65-charge solar burst adds speed and protection for 2.8 seconds.
- Skilled timing extends runs: sampled simulations averaged roughly 2 km for idle/held play, 5 km for rhythmic dives, 7.5 km with bursts, and 10 km with slope timing. Three seconds of airtime is attainable by bursting near an apex.
- Region palettes change every 1,000 m and cycle endlessly. Portrait gameplay renders at least 900 logical units of course width so hazards have useful lead time. A pennant marks the player's previous personal horizon.
- Daily seeds and records use UTC dates captured at run start. Free flight tracks lifetime journeys only, preserving the meaning of earned records and unlocks. The first three incomplete missions are eligible per run; settlement runs exactly once.
- Progress survives reloads with validated local saves, and blocked storage falls back to the session with honest UI feedback. Skiffs are cosmetic. Fonts are local with OFL licenses; no runtime services or downloaded game assets are required.
- Sound is gesture-unlocked, speed-reactive, and muted by default. Web Audio resources are bounded and recreated after StrictMode cleanup. Focus loss pauses the run; reduced motion removes shake and speed streaks.

## Validation

- Exact repository gate passes: scope, conformance, frozen pnpm install, ESLint, TypeScript/Vite build, relative deployment assets, and static 16:10 thumbnail.
- Engine checks pass: input transitions, stable frame rates, pause, seeded layouts, pickup/damage/burst collisions, sunlight depletion, advanced airtime, and bounded four-minute practice simulation.
- 12 progress checks pass: corrupt saves, invalid numbers, unavailable storage, ownership validation, mission eligibility, once-only mission rewards, daily dates/seeds, and practice isolation.
- Seven production browser scenarios pass: keyboard/pointer run lifecycle, saved settlement, deterministic daily course, practice isolation, hangar purchases, 320/390 px real touch play, and sound/pause/reload controls. No console errors or horizontal overflow.
- Visually reviewed desktop/mobile welcome, flight, results, and region palettes; loaded the built game at a nested static-server subpath without failed asset requests. Browser screenshots stay ignored in `qa/artifacts/`.

- 2026-09-24 (codex / gpt-6): Built and balanced the complete Sunwake game, refined mobile lookahead and dark-region contrast, verified persistence and reward isolation, and passed the exact publication gate. Release is ready for the automatic pull-request workflow.

## Second journey — improvement plan

- [x] Varied continuous terrain profiles, thermals, shields, magnets, ring chains, and perfect landings.
- [x] Best-run ghosts, same-course retries, and shareable versioned course links.
- [x] Flight log, richer debriefs, expanded challenges, and old-save migration.
- [x] Contextual flight coaching, readable power-up timers, larger touch controls, and input fixes.
- [x] Region-specific sky scenery and performance improvements.
- [x] Verify determinism, balance, persistence, browser behavior, and the exact gate; prepare the update for automatic PR publishing.

## Version 0.2 decisions

- Four dune profiles now vary the rhythm of each region. Quintic blending preserves terrain height and slope through every transition. Coordinate-based placement keeps shared courses independent of player input.
- Shields absorb one obstacle hit. Magnets gather sparks for ten seconds and pull fast enough to catch a bursting skiff. Rising thermals reward an open sail. Three consecutive rings within nine seconds of one another grant a sky-chain bonus and eight seconds of magnet; missing a ring breaks the chain. Gentle downhill landings earn perfect-landing rewards.
- Active bursts cannot be renewed, and recharge runs at 30% while bursting. In 16-seed simulations capped at 180 seconds, idle/held play averaged about 3.2/3.8 km, rhythmic bursts 9.9 km, and slope-timed bursts 12.0 km. Skilled averages are capped observations, not expected maximum distances. The new pickups extend well-flown journeys without making ordinary holds competitive.
- Course URLs use `#/course/2/<seed>`; unsupported versions are rejected. Links share a landscape, not another person's replay. Ghosts come from this device's best competitive flight on the same course, with at most four stored courses. Recordings start at five samples per second and progressively compact to at most 960 points while preserving both endpoints, including a finish exactly at the compaction boundary.
- Flight history retains twelve journeys, with old daily routes replayable as Voyage. The debrief shows a height trace, perfect landings, sky chains, longest glide, top speed, and a situational tip. Four new challenges extend the journal to sixteen. Existing records, skiffs, light, and completed challenges migrate without resetting progress.
- Coaching and ghost visibility are saved preferences. Input sources release independently. Portrait event messages occupy the coaching slot below the course, keeping approaching obstacles visible; touch targets and debrief labels are larger. Reduced motion freezes ambient flourishes and removes rapid invincibility blinking.
- Violet Reach gains suspended islands and Blue Hour gains aurora ribbons. Terrain phase caching and fewer contour samples reduce render work; ready and paused screens no longer schedule repeated React HUD snapshots.
- Verification: 22 progress/replay/input checks and expanded engine checks pass, including deterministic frame rates, four-minute free flight, shields, chains, thermals, magnet pursuit at burst speed, and smooth terrain. Twelve production browser scenarios pass with clean consoles, covering old flows plus shared-route ghosts, log replay, independent inputs, preferences, blocked clipboard/storage, and landscape fullscreen. The exact publication gate passes. Final visual review covered desktop, 320/390 px portrait, 844 px landscape, violet islands, and blue aurora. Landscape touch controls retain their styling, and the results fit without scrolling.

- 2026-09-24 (codex / gpt-6): Thoroughly expanded Sunwake's flight mechanics, replay loop, world variation, coaching, and saved history; balanced the new rewards, preserved existing progress, and passed the exact gate plus engine/unit/browser coverage. Version 0.2 is ready for the automatic PR publishing workflow.
