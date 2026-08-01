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
- [x] Add ADSR Envelope Node
- [ ] Add Sequencer Node
- [x] Add Master Volume Control in Output Node
- [x] Add Panning Node
- [x] Add Distortion Node
- [x] Add Chorus/Flanger Node
- [x] Implement Node Deletion UI (e.g. Delete button on nodes)
- [x] Allow renaming nodes for better organization
- [ ] Add Save/Load patches functionality
- [x] Improve Visualizer with dual view (Waveform + Spectrum)

## Expansion Phase 3 (Planned)
- [x] Add Compressor Node
- [x] Enable snap-to-grid in React Flow
- [x] Add Master Limiter to AudioCore
- [x] Implement multi-node selection
- [ ] Add copy/paste functionality for nodes
- [ ] Add MIDI input support via Web MIDI API
- [ ] Implement undo/redo functionality
- [ ] Create a comprehensive preset library
- [ ] Add polyphony support to Oscillator
- [x] Allow custom colors for different node types
## Expansion Phase 4 (New Improvements)
- [x] Add Bitcrusher Node
- [ ] Add Phaser Node
- [x] Add Ring Modulator Node
- [x] Add Tremolo Node
- [ ] Implement Node Bypassing
- [ ] Add Dark/Light Theme Toggle
- [ ] Add Auto-Panning Node
- [x] Enhance Filter Node with more types (highpass, bandpass)
- [ ] Add Master EQ Node
- [ ] Improve UI for Mobile Devices
- [ ] Add Node Groups
- [ ] Add Keyboard shortcuts for common actions

## Expansion Phase 5 (Future Improvements)
- [ ] Add Pitch Shift Node
- [ ] Add Arpeggiator Node
- [ ] Add Wavefolder Node
- [ ] Add Granular Synth Node
- [ ] Add Multi-band Compressor Node
- [ ] Implement preset sharing via URL
- [ ] Add oscilloscope visualization modes
- [ ] Add MIDI output support
- [ ] Implement node cloning shortcut
- [ ] Add contextual help for nodes

## Expansion Phase 6 (Added Improvements)
- [x] Add a Master Mute button to Output Node
- [x] Add a "Clear All Nodes" button to the sidebar
- [x] Add a Detune control to the Oscillator Node
- [ ] Add a visual metronome for the Sequencer Node
- [ ] Implement Node grouping and encapsulation
- [ ] Allow recording Master Output to a .wav file
- [ ] Add a Spectrum Analyzer with log-scale frequencies
- [ ] Implement custom keyboard shortcuts for node creation
- [ ] Add a saturation/tape warmth node
- [ ] Implement variable LFO waveforms
- [ ] Implement auto-save to localStorage
- [ ] Add tooltips and visual guides for new users
- [ ] Add stereo widening utility node
