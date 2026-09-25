# Lumen: The Lost Gardens

An unhurried light-routing puzzle game. Rotate carved stone channels on a floating garden to connect a sun well to every sleeping crystal.

## Play

- **48 campaign gardens** across six chapters, with an ending and six recoverable journal memories.
- **Six evolving rules:** turning channels, branches, rooted stones, directional gates, isolated bridges, and paired portals.
- **A daily garden** shared by UTC date, with date links that remain replayable.
- **Seeded workshop gardens:** choose a chapter's rules and any 32-bit seed; share the resulting URL.
- **A complete garden designer:** compose 5×5, 6×6, or 7×7 boards, test their scrambled form, and share self-contained puzzle links.
- **Six distinct chapter palettes**, visible light frontiers, awakened flowers, and an overhead view with larger square targets for small screens.
- **Three-bloom awards**, eight achievements, undo/redo, restart, and optional two-step hints.
- **Local saves and portable backups**, keyboard support, reduced motion, contrast settings, and optional synthesized sound and ambience.
- Every chapter is open from the beginning. There are no timers, accounts, ads, or network game services.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Turn a stone clockwise | Click / tap | Tab to stone, then Enter or Space |
| Turn counterclockwise | Shift + click | Shift + Enter / Space |
| Move focus across stones | — | Arrow keys |
| Undo | Undo | Z or U |
| Redo | Redo | Y or Shift + Z |
| Toggle overhead view | View toggle | V |
| Restart | Restart | R |
| Hint | A gentle nudge | H |
| Field guide | Help / Field guide | ? |
| Close dialog / leave focus mode | Close | Escape |

A hint first identifies a useful stone. Request it again to rotate that stone to the guide solution. Hints reduce the current attempt's award to one bloom. Three blooms require a solution within the displayed turn guide without hints; any other unassisted solution earns two. The guide is a known-solution budget, not a claim of a mathematically shortest solution. Undo preserves the hint count; restarting begins a new attempt. Best awards remain saved when replaying.

Each garden saves its own arrangement, hint state, and up to 100 undo and redo steps. Switching gardens or reloading keeps those records. The atlas offers resume shortcuts. The library retains the most recent 200 gardens; completed awards are stored separately. The previous single-garden save migrates automatically. Export/import in Settings transfers completed gardens; it does not transfer unfinished arrangements or undo history. Importing preserves existing best scores. If storage is unavailable, playing still works and the footer advises creating a backup. Saved ambience begins after the next player interaction; audio never starts on page load.

## Design and share a puzzle

Open **Workshop → Design a garden**. Start with the editable example or clear the stones, choose a size, and place sun wells, crystals, channels, branches, gates, bridges, and portals. The **Turn** tool can orient any stone while designing, including fixed terminals. Use the brush rotation and fixed toggle before placing stones. Portals can belong to pair A or pair B; each used pair needs exactly two portals. A compact brush selector sits beside the grid on mobile.

Connect every crystal in the blueprint. Validation explains missing terminals, disconnected crystals, incomplete portal pairs, or arrangements that remain solved regardless of turns. A valid design can be tested as a deterministic scramble or copied as a link. Shared links contain the whole puzzle and need no server or account. The game provides hints and awards for custom gardens too.

Your draft saves locally after edits. Arrow keys move around the editor, R turns the focused stone, Shift + R turns it backward, Delete clears it, and Ctrl/Command + Z undoes an edit. Resizing and clearing can be undone while the designer remains open. Designer edit history is separate from game undo history and does not survive closing the designer.

## Development

```sh
pnpm install
pnpm dev
pnpm lint
pnpm build
node --test tests/*.test.mjs
pnpm exec playwright install chromium
pnpm exec playwright test
```

Use Node 24 for the engine tests (native TypeScript stripping). Browser tests accept `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when Chromium is already installed elsewhere. Playwright starts a local Vite server and keeps screenshots/traces under ignored `node_modules/.cache/`.

Run the repository's exact release gate from the repository root:

```sh
node scripts/verify-project.mjs lumen-atelier-8f3c
```

## Implementation

- `src/game.ts`: deterministic generation, solutions, light propagation, and hints. Sources and receivers are fixed; light requires reciprocal ports. A bridge keeps its two channels isolated, gates accept only the correct incoming direction, and matched portals connect distant components. Visited entry states prevent infinite cycles.
- `src/Board.tsx` and `src/boardThemes.ts`: responsive interactive SVG, chapter palettes, isometric/overhead projections, light frontiers, and procedural stone, crystal, plant, and light artwork.
- `src/App.tsx`: campaign, atlas, workshop, journal, settings, awards, hash routing, and current-session state.
- `src/progress.ts`: validated persistent records and portable, mergeable backups.
- `src/sessions.ts`: validated per-garden arrangements, undo/redo history, summaries, bounded storage, and legacy save migration.
- `src/CustomGarden.tsx` and `src/custom.ts`: live puzzle designer, strict share validation, portable codec, deterministic scrambling, and guide solutions.
- `src/audio.ts`: small Web Audio instrument with lazy creation and explicit cleanup.

All imagery, typography, and code are served from the app's relative Vite base. The only runtime persistence is browser local storage. No tracking or third-party requests.
