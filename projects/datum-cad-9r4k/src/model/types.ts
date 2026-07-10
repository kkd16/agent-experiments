// Core data model for the parametric sketch.
//
// The sketch follows the "everything reduces to points" philosophy (as in
// SolveSpace): the only things that carry solvable parameters are point
// coordinates and circle radii. Lines are pure references to two points, so a
// line never needs its own degrees of freedom — its position is whatever its
// endpoints say it is. This keeps the free-parameter vector minimal and the
// constraint Jacobian well conditioned.

export type EntityId = number

export type PointEntity = {
  kind: 'point'
  id: EntityId
  x: number
  y: number
  // A fixed point is a Dirichlet boundary: its (x,y) are held constant and are
  // excluded from the free-parameter vector the solver moves.
  fixed: boolean
  // Construction points (e.g. circle centers) are drawn faintly; they still
  // participate in the solve exactly like any other point.
  construction?: boolean
}

export type LineEntity = {
  kind: 'line'
  id: EntityId
  p1: EntityId
  p2: EntityId
  construction?: boolean
}

export type CircleEntity = {
  kind: 'circle'
  id: EntityId
  c: EntityId // center point
  r: number
  construction?: boolean
}

// A circular arc, in the same "everything reduces to points" spirit: it references
// a center point `c` and two endpoint points `p1` (start) and `p2` (end), and — like
// a circle — carries a solvable radius `r`. The arc is the counter-clockwise sweep
// from p1 to p2. Two *intrinsic* residuals (|p1−c| = r and |p2−c| = r) bind both
// endpoints to the circle of radius r, so the endpoints are ordinary draggable
// points that always land on a common circle. Because an arc exposes the same
// (center, radius) pair as a circle, every circle relation — radius, diameter,
// equal-radius, concentric, point-on, tangent-to-line, tangent-to-circle — applies
// to arcs unchanged (see `Sketch.circleLike`).
export type ArcEntity = {
  kind: 'arc'
  id: EntityId
  c: EntityId // center point
  p1: EntityId // start point (arc sweeps CCW from here)
  p2: EntityId // end point
  r: number
  construction?: boolean
}

// A cubic Bézier spline, in the same "everything reduces to points" spirit as the
// arc: it references four points — the two endpoints `p0` (start) and `p1` (end)
// and the two control handles `c0` (off the start) and `c1` (off the end). The
// curve is B(t) = (1−t)³P0 + 3(1−t)²t·C0 + 3(1−t)t²·C1 + t³·P1, so it is fully
// determined by those four points and carries **no free parameter of its own**
// (exactly like a line, which reduces to its two endpoints). A free spline
// therefore has 8 degrees of freedom (four draggable points) and needs no
// intrinsic residual. Its endpoint tangent directions are the handle vectors
// B′(0) ∝ (C0−P0) and B′(1) ∝ (P1−C1) — the basis of the three tangency
// constraints below (see `Sketch.splineHandleAt`).
export type SplineEntity = {
  kind: 'spline'
  id: EntityId
  p0: EntityId // start point
  c0: EntityId // control handle off the start
  c1: EntityId // control handle off the end
  p1: EntityId // end point
  construction?: boolean
}

export type Entity = PointEntity | LineEntity | CircleEntity | ArcEntity | SplineEntity

// The union of entities that expose a (center point, radius) pair — a circle or an
// arc. Every "circular" constraint is defined once over this shape.
export type CircularEntity = CircleEntity | ArcEntity

// The kinds of geometric relations the solver understands. Each maps to one or
// more scalar residual equations that the solver drives to zero.
export type ConstraintKind =
  | 'coincident' // two points share a location            (2 residuals)
  | 'horizontal' // a line is horizontal                    (1)
  | 'vertical' // a line is vertical                       (1)
  | 'parallel' // two lines are parallel                   (1)
  | 'perpendicular' // two lines meet at 90°                (1)
  | 'equalLength' // two lines have equal length            (1)
  | 'equalRadius' // two circles have equal radius          (1)
  | 'distance' // point-point distance = value             (1)
  | 'pointOnLine' // point lies on an (infinite) line       (1)
  | 'pointOnCircle' // point lies on a circle                (1)
  | 'radius' // circle radius = value                      (1)
  | 'diameter' // circle diameter = value                  (1)
  | 'tangentLineCircle' // a line is tangent to a circle    (1)
  | 'tangentCircles' // two circles are mutually tangent    (1)
  | 'concentric' // two circles share a center             (2)
  | 'angle' // signed angle between two lines = value      (1)
  | 'midpoint' // a point is the midpoint of a line        (2)
  | 'symmetric' // two points are mirror images across a line (2)
  | 'colinear' // two lines are colinear                    (2)
  | 'splineTangentLine' // a spline endpoint is tangent to a line   (1)
  | 'splineTangentSpline' // two splines meet with a smooth G1 join (1)
  | 'splineTangentArc' // a spline endpoint is tangent to a circle/arc (1)

export type Constraint = {
  kind: ConstraintKind
  id: EntityId
  // Referenced entities, order matters per constraint kind.
  entities: EntityId[]
  // Optional numeric target (distance, angle in degrees, radius, …).
  value?: number
  // Marks a constraint whose `value` is animated by the driver to sweep a
  // mechanism through its motion.
  driver?: boolean
}

export type SketchData = {
  entities: Entity[]
  constraints: Constraint[]
  nextId: number
}
