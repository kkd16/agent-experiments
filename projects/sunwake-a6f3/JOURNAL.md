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
- [x] More skiff silhouettes: the two-wing Kestrel, earned through the Sun Atlas.
- [ ] Future: additional expedition chapters.

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

## Third journey — Sun Atlas plan

- [x] Six finite expeditions across the four regions, finish beacons, checkpoints, route conditions, and three replayable seals per route.
- [x] Persistent expedition progress, honest reward isolation, unlockable wakes, and the Kestrel skiff; preserve existing saves and version-2 course links.
- [x] An illustrated Sun Atlas, clear live objectives, expedition results, and quick same-route retries.
- [x] Standard controller support with independent input and safe disconnect behavior.
- [x] Better flight feedback, cosmetic settings, mobile/fullscreen layouts, and meaningful regression coverage.
- [x] Balance every expedition, pass the exact gate, and prepare the update for automatic PR publishing.

Design: preserve the warm sail-and-dunes world, Bricolage display and DM Sans body, plum #342c40, chalk #faf7f2, amber #f3ba7b, rose #b86783, turquoise #75d8ce, and violet #b798db. The new signature is a charted ribbon of six destinations across a painted atlas, with seals stamped into each route. The atlas stays a focused dialog; the playable horizon stays the main page's centerpiece. Cosmetics express progress without changing the physics of existing competitive modes.

## Version 0.3 decisions and validation

- Six authored routes run from 650 to 2,400 m, beginning in different regions. Their conditions include tailwind, fragile light, a half-lit lantern, and buoyant air. Two intermediate beacons each grant 12 sunlight and 8 charge; crossing the destination ends the run automatically. Aborting or running out of light never earns seals.
- Each route offers arrival, finesse, and swift seals. Finesse targets landings, rings, sparks, clean navigation, or thermals; swift targets range from 16 to 52 seconds. Seals accumulate across attempts and pay 40 light once each. Finishing a route opens the next. Expedition runs award collected sparks and track history/lifetime distance, with separate times/seals and no changes to Voyage/Daily records, challenges, or ghosts.
- Version-2 course physics are retained exactly. Twelve 100-second simulations across four seeds and all three original modes matched every pre-existing state field against the deployed 0.2 engine. Expedition URLs use a separate versioned atlas route; links open route details and retain the normal progression requirement. Ghost recording remains exclusive to the original competitive modes.
- Three seals unlock Seafoam, six Wild violet, twelve Aurora and the Kestrel, and eighteen Stardust. The hangar previews all four skiffs and five wakes. Unlock announcements link directly to the hangar. Cosmetic selection persists and cannot load before its seal requirement is met.
- The illustrated map has numbered routes, readable locked previews, persistent seals, and route-specific objectives. A sticky mobile departure control keeps the action available while scrolling. Results distinguish this flight's seals from already collected seals, show crossing time to hundredths, and offer the next expedition. Swift boundaries tolerate floating-point drift without rewarding a late simulation tick.
- Standard Gamepad input supports bottom-face/right-trigger dives, right/left-face or left-trigger bursts, Menu pause/resume, and start/result retries. Independent input sources preserve keyboard/touch holds. Disconnecting pauses the run. Paused flights also have a same-route restart button and R shortcut; R after results repeats the course.
- Priority flight messages preserve important chain, checkpoint, and damage feedback. Checkpoints and arrival gain audio cues. The static catalog thumbnail now shows a destination beacon. Normal rendering and input remain bounded; no new runtime libraries or services were added.
- Verification: exact repository gate passes; expanded engine checks and 33 unit tests pass. All six expeditions achieve all three seals in deterministic simulations, and arrival is identical at 30/60/144 Hz. Twelve existing browser scenarios plus seven atlas/controller scenarios pass. Real UI automation earned all three first-route seals, unlocked Seafoam, and selected the wake. Gamepad behavior was tested with simulated standard API data, not physical hardware.
- Visual review covered the desktop atlas, mobile atlas at 320/390 px, a three-seal mobile finish, the hangar/Kestrel, fullscreen landscape results, and the new static thumbnail. Screenshots and exploratory scripts stay ignored under `qa/artifacts/`.

- 2026-09-24 (codex / gpt-6): Built and balanced the Sun Atlas expansion, preserved old saves and course physics, added collectible wakes/Kestrel and controller support, and passed engine/unit/browser/publication checks. Version 0.3 is ready for the automatic pull-request publishing workflow.

## Fourth journey — polish and smoothness

- [x] Measure rendering cost, stop unnecessary background/paused drawing, and smooth presentation between physics ticks without changing course rules.
- [x] Fix input, controller handoff, focus, scrolling, and fullscreen edge cases; make return-to-flight actions immediate and dependable.
- [x] Refine flight preferences, motion/accessibility, live feedback, and small-screen controls while retaining the illustrated world.
- [x] Verify existing saves, identical physics, realistic browser flows, performance, and the exact publishing gate; publish the update.

Design stays with Sunwake's existing sail, sun, and contour-line landscape: plum #342c40, chalk #faf7f2, amber #f3ba7b, rose #b86783, turquoise #75d8ce. Bricolage titles, DM Sans controls, and tabular flight instruments remain. This pass prioritizes responsive flight and quiet, readable controls over new content.


## Version 0.3.1 decisions and validation

- One scheduler now polls controls, advances the simulation, updates audio, and draws. Paused screens, results, and menu backgrounds redraw only for a change or resize. Hidden tabs schedule no loop work; the welcome scene targets about 30 FPS and stays still under reduced motion. The old app-level 50 ms frame clamp caused slow motion below 20 FPS; it now accepts the engine's existing 100 ms catch-up limit. A browser check delivering frames every 64 ms confirms that ten seconds of wall time remains about ten seconds of flight.
- Skiff position, rotation, camera, scenery time, and ghost presentation interpolate between the original 120 Hz physics steps. Gameplay state, collisions, rewards, and recorded ghosts remain authoritative and unchanged. Sixteen 100-second simulations across four modes/four seeds matched every state field against version 0.3. Separate checks cover smooth, monotonic presentation at 60/90/144/240 Hz and clean pause/resume/reset boundaries.
- The renderer reuses bounded terrain samples in a 4,096-slot cache per canvas. Checked errors stay below 0.02 logical pixels across negative positions, four regions, long courses, seed changes, and cache wrap; collision terrain stays exact. Automatic scenery detail budgets roughly two million backing pixels, with explicit Sharp and Light alternatives. These change drawing resolution, never frame rate or handling.
- Flight settings are reachable from the stage, including fullscreen and pause. Saved controls cover scenery detail, device/reduced/full motion, sounds, coaching, and ghosts. Old saves default to Automatic/Follow device without losing records or unlocks. Muted play no longer constructs an audio graph, and enabled audio suspends after fading on pause or completing the arrival chime.
- Launches and resumes reveal the stage and return keyboard focus. A paused flight focuses Keep flying for normal keyboard activation. Focus loss, hidden tabs, scrolling the game out of view, controller loss, and leaving fullscreen pause safely with a useful explanation. Swapping away from a disconnected controller cannot use the second controller's held buttons to immediately resume. Right-click no longer dives, keyboard navigation cannot accidentally boost from a focused button, M toggles sound, and Space after results retries the same course.
- Dialogs lock background scrolling, keep their close button visible, and distinguish a backdrop click from a drag beginning inside. Fullscreen labels track the actual state and notices appear within the fullscreen stage. Short landscape views use compact controls/results even outside fullscreen. Mobile instruments and touch labels are larger; burst charge is explicit; coaching and events have space above the speed readout; live digits use tabular spacing.
- Measurement: in local headless Chromium at a 1440 × 1050 viewport, three-second observation windows previously contained 95 paused, 36 menu-background, and 98 results world paints. The updated windows contain zero for all three (and still repaint on resize). Ready-scene paints dropped from 181 to 70 in the observed windows. These are local render observations, not a claim about FPS or battery life on every device.
- Verification: exact publication gate, engine checks, and 38 unit tests pass. Twelve existing gameplay scenarios, seven atlas/controller scenarios, and ten polish scenarios pass in production Chromium. Added checks cover frozen canvas counts, hidden tabs, slow render frames, audio suspension, saved visual preferences, controller handoff, right-click isolation, mobile scrolling/focus, backdrop drags, sticky dismissal, and fullscreen exit. Final visuals reviewed at desktop, 320/390 px portrait, and 844 px landscape. Artifacts remain ignored in qa/artifacts.

- 2026-09-24 (codex / gpt-6): Completed Sunwake's performance, smoothness, bug-fix, and quality-of-life pass. Preserved course physics and saves, verified the exact publishing gate, and prepared version 0.3.1 for automatic PR publishing.
