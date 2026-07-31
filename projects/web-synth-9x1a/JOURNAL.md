# Web Modular Synth Journal

- [x] Add Tailwind CSS
- [x] Add Audio Core
- [x] Add React Flow nodes
- [x] Final integrations

## Expansion Phase 1
- [x] Add LFO Node
- [x] Add Reverb Node
- [x] Add Analyser Node

## Session Logs
- 2024-05-18: Initialized project. Setup audio core and UI components. Solved any typings. Verified CI.
- Reflected on feedback: Fixed connection/disconnection logical issues in `src/store.ts`. Connection targets correctly identify default inputs versus parameters. Ensure edge removal happens before state mutation.

## Expansion Phase 2 (Improvements)
- [ ] Add ADSR Envelope Node
- [ ] Add Sequencer Node
- [x] Add Master Volume Control in Output Node
- [ ] Add Panning Node
- [ ] Add Distortion Node
- [ ] Add Chorus/Flanger Node
- [x] Implement Node Deletion UI (e.g. Delete button on nodes)
- [ ] Allow renaming nodes for better organization
- [ ] Add Save/Load patches functionality
- [x] Improve Visualizer with dual view (Waveform + Spectrum)
