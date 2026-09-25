# Lumen: The Lost Gardens — journal

An atmospheric puzzle game about restoring floating gardens with light. The campaign introduces six optical mechanisms over 48 puzzles; daily and seeded workshop gardens keep the game open-ended.

## Design

- Palette: parchment mist `#f0f3ed`, limestone `#d5dfca`, deep lagoon `#133d3c`, forest ink `#243e36`, sunlight `#e8bd70`, faded lilac `#ada6c0`.
- Typography: Cormorant Garamond for literary titles, DM Sans for clear interface text. All fonts bundled locally.
- Layout: calm botanical field guide surrounding a large, luminous isometric stone garden. The playable garden is the hero.
- Signature: light traces engraved paths across floating stone slabs and wakes faceted seed crystals.
- Aesthetic review: avoided a generic space dashboard; the botanical field-guide frame and tactile light-bearing ruins ground the interface in the game's subject.

## Ideas / backlog

- [x] 48 verified campaign puzzles across six chapters
- [x] Isometric interactive garden with keyboard and touch support
- [x] Daily puzzle and shareable seeded workshop gardens
- [x] Undo, restart, two-stage hints, chapter selection, and completion awards
- [x] Local progress, backup/import, settings, and optional synthesized audio
- [x] Field guide, narrative memories, and achievements
- [x] Responsive design and reduced motion support
- [x] Custom static catalog thumbnail
- [x] Engine and browser interaction verification
- [x] Run exact repository gate and publish a PR
- [ ] Future: a freeform tile editor and community puzzle exchange

## Session log

- 2026-09-24 (codex, gpt-6): Started from the required template; established visual direction and parallelized puzzle engine, garden renderer, and persistence/audio work.

- 2026-09-24 (codex, gpt-6): Shipped the full campaign, atlas, daily/workshop, eight achievements, journal ending, responsive isometric renderer, synthesized audio, local sessions, safe progress backups, and accessibility settings. Verified all 48 solutions and 600 generated boards with 11 engine tests; browser tests cover real pointer solves, gates/bridges/portals, hints/undo, backups, mobile, and the ending. Fixed deep-link resume, storage failure reporting, and saved ambience without autoplay. Exact repository conformance/lint/build/output gate passed.

## Follow-up notes

- The canonical guide turn count is a known valid solution budget; it is not an optimality proof.
- The workshop generates reproducible boards from seeds. A freeform tile editor remains a separate future feature.
- Save data is device-local. Export transfers completed gardens; only the active arrangement is saved locally and undo history resets on reload.
- Font subsets are bundled locally; game, art, and audio need no external services.
- See README.md for development and verification commands.

- 2026-09-24 (codex, gpt-6): Final release verified with 11 engine tests, 13 browser scenarios, and the exact repository gate. Publishing the isolated project branch through the mandatory auto-merge PR workflow.
