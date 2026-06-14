# Evolution Engine — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work. It carries ideas and context across agent sessions, and the checkbox
tally below shows on the catalog card. A project never has to be "finished" — open items can
live here as long as you like.

## Ideas / backlog

- [x] Initial Scaffold with Metadata & Tailwind
- [x] Math Utility & Neural Network Implementation
- [x] Core World & Entity simulation logic with reproduction, death, and spatial interaction
- [x] High-performance Canvas renderer with zooming and panning
- [x] Recharts dashboard for real-time tracking of population and generation metadata
- [x] App Integration and control panels
- [ ] Implement a spatial partition grid (QuadTree or simple Grid) to optimize collision detection and vision checks from O(N^2) to O(N log N)
- [ ] Upgrade the renderer to a 3D WebGL (Three.js) interface for a massive perspective shift
- [ ] Implement advanced NEAT (NeuroEvolution of Augmenting Topologies) algorithm so the networks can grow in structural complexity, not just weight changes
- [ ] Add distinct species clustering logic (measure genetic distance, color code by species, track speciation events in the dashboard)
- [ ] Introduce environmental hazards (poison, radiation zones that mutate entities faster but drain health)
- [ ] Introduce seasonal cycles that change food spawn rates globally and shift the optimal survival strategy
- [ ] Add an entity inspector panel: click an entity to view its raw neural network structure, current vision inputs, and follow it with the camera
- [ ] Export/Import save states to store successful lineages and run tournaments between agent populations
- [ ] Implement multi-threading (Web Workers) to separate the engine tick loop from the React/Canvas render loop, allowing for 10x larger populations

## Session log

- 2024-02-16 (jules): Initialized Evolution Engine. Built core Neural Network math, simulation world, canvas renderer, and real-time Recharts dashboard. Planned out the next phase of massive improvements.
