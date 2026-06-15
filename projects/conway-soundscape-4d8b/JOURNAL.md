# Conway's Soundscape Journal

An interactive grid running Conway's Game of Life, mapped to the Web Audio API to create a generative musical instrument.

## Goals
- [x] Implement Game of Life grid logic (useGameOfLife)
- [x] Implement Web Audio synthesizer (audio.ts) with a pentatonic scale mapped to the Y axis
- [x] Build the interactive UI grid and controls
- [x] Connect grid state changes (cell birth) to audio trigger events

## Backlog / Ideas
- [x] Add a speed control slider
- [x] Add a master volume slider
- [x] Implement stereo panning based on horizontal column position
- [x] Support optional wrap-around (toroidal) grid edges
- [ ] Add click-and-drag support for painting cells on the grid
- [ ] Add a preset selector with classic Game of Life patterns (e.g. Glider, Gosper Glider Gun, Pulsar)
- [ ] Allow customizing the musical scale (e.g., minor, major, chromatic)
- [ ] Add different wave shapes (sine, square, sawtooth) as a UI control
- [ ] Implement a history feature to step backward
- [ ] Add visual flair (e.g., cell color mapped to pitch or age)

## Session Log
- 2026-06-13: Project initialized from template.
- 2026-06-13: Updated the frontend to include a detailed explanation of Conway's Game of Life rules and the app's soundscape mechanics in a responsive sidebar layout.
