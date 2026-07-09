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

export type Entity = PointEntity | LineEntity | CircleEntity

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
