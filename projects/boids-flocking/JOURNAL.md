# Project Journal

## Session: 2024-05-24

### Tasks Completed
1. Created project structure by duplicating the template to `boids-flocking`.
2. Updated project metadata in `project.json` and `package.json`.
3. Implemented standard Vector mathematics to support 2D physics.
4. Implemented the core Boid logic:
   - Separation (steering to avoid crowding local flockmates)
   - Alignment (steering towards the average heading of local flockmates)
   - Cohesion (steering to move toward the average position of local flockmates)
5. Created a responsive HTML5 Canvas component in React (`BoidsCanvas.tsx`).
6. Built an interactive UI panel in `App.tsx` allowing for real-time adjustments of all the fundamental boids parameters.

### Notes
- Chose an elegant dark theme using `#0f172a` (slate-900) as a backdrop.
- Boids have a slight trail effect via partial clearRect/fillRect opacity trick in canvas.
- Boids change colors automatically using an HSL approach.
## Session: 2024-06-15

### Backlog & Planned Improvements
- [x] Add an edge behavior toggle (Wrap Around vs Bounce).
- [x] Add Predator boids that hunt regular boids.
- [x] Make regular boids flee from Predators.
- [x] Add individual speed/size variance to regular boids for a more organic look.
- [x] Optimize the flocking neighbor search with a QuadTree or Grid-based spatial partitioning to support 1000+ boids.
- [x] Implement a "wind" force that pushes all boids in a certain direction.
- [x] Add boid shapes/types: draw boids as triangles, arrows, or circles based on a toggle.
- [x] Add a visual performance metric (FPS counter) to measure the effectiveness of optimizations.
- [x] Add a "pause/play" button to freeze the simulation.
- [x] Add interactive obstacles that boids must steer around.
- [x] Allow the user to click to place/remove obstacles on the canvas.
- [ ] Implement a "follow the leader" mode where boids try to follow a specific designated boid.
- [x] Add color trails to the canvas for a continuous path effect.
- [ ] Add a visual toggle for viewing the "sensory radius" (visual range) of a selected boid.
- [ ] Implement a "scatter" effect when the user clicks the canvas, making boids temporarily flee from the click point.
- [x] Add a background grid or starfield that slowly scrolls.
- [ ] Introduce "food" items that boids can eat to grow in size or speed.
- [ ] Implement boid reproduction when two boids stay close and "eat" enough food.
- [ ] Allow different species of boids (different colors/behaviors) that form separate flocks or compete.
- [x] Implement "gravity" slider to apply constant vertical forces to all boids.
- [ ] Make obstacles draggable so the user can easily reposition them.
- [ ] Add "chaos mode" that randomly fluctuates parameter values over time.
- [ ] Add sound effects for boid collisions or feeding.
- [ ] Implement a heatmap overlay showing boid density.
- [ ] Add spatial partitioning grid visualization for debugging.
- [ ] Introduce "lazy" boids that have lower max speeds and prefer to stay still.
- [ ] Implement directional light sources affecting boid coloring.
- [ ] Add an option to save/load flock parameter presets.
- [ ] Allow drawing custom barrier shapes instead of just points.

### Tasks Completed
