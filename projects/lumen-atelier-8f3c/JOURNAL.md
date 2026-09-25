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
- [x] Freeform garden designer with verified, shareable puzzles
- [x] Per-garden resume with persisted undo/redo
- [x] Distinct chapter scenery, animated light, and visible light frontiers
- [x] Overhead board view for clearer play on small screens
- [x] Updated mechanic guidance and resume shortcuts

## Session log

- 2026-09-24 (codex, gpt-6): Started from the required template; established visual direction and parallelized puzzle engine, garden renderer, and persistence/audio work.

- 2026-09-24 (codex, gpt-6): Shipped the full campaign, atlas, daily/workshop, eight achievements, journal ending, responsive isometric renderer, synthesized audio, local sessions, safe progress backups, and accessibility settings. Verified all 48 solutions and 600 generated boards with 11 engine tests; browser tests cover real pointer solves, gates/bridges/portals, hints/undo, backups, mobile, and the ending. Fixed deep-link resume, storage failure reporting, and saved ambience without autoplay. Exact repository conformance/lint/build/output gate passed.

## Follow-up notes

- The canonical guide turn count is a known valid solution budget; it is not an optimality proof.
- The workshop now includes both seeded generation and a complete freeform designer. Custom links carry validated solved layouts and derive deterministic unsolved boards and hints. Portal pairs are visibly labeled A/B.
- Save data is device-local. Export transfers completed awards. The new per-garden library retains up to 200 arrangements and 100 undo/redo steps per garden, with legacy migration. Designer drafts persist; editor undo lasts for that editor session.
- Font subsets are bundled locally; game, art, and audio need no external services.
- See README.md for development and verification commands.

- 2026-09-24 (codex, gpt-6): Final release verified with 11 engine tests, 13 browser scenarios, and the exact repository gate. Publishing the isolated project branch through the mandatory auto-merge PR workflow.

- 2026-09-24 (codex, gpt-6): Began the Second Bloom update: a real workshop designer, richer chapter identity, clearer light feedback, overhead play, and independent saved gardens with undo/redo. Preserve the original botanical field-guide palette and type; make the new designer a usable drafting table rather than another decorative dashboard.

- 2026-09-24 (codex, gpt-6): Completed Second Bloom: full validated puzzle designer and self-contained share links; per-garden resume, redo, and migrated saves; distinct chapter palettes, animated light frontiers and blooming completion; overhead mobile play and portal pair labels. Visual review added a compact mobile drawing brush and larger editor text. Validation: 32 logic/storage/codec tests, 20-test full browser suite plus the new mobile quick-brush check and related designer regressions.
- 2026-09-24 (codex, gpt-6): Second Bloom release gate passed (scope, conformance, frozen install, lint, build, output). Publishing version 1.1.0 through a project-only PR; completed awards are preserved and old active saves migrate safely.
