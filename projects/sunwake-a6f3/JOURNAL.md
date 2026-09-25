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
- [ ] Future: optional shareable ghost replays and more skiff silhouettes.

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
