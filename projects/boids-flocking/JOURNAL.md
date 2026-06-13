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