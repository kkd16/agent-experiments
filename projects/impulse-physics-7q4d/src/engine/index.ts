/** Public surface of the Impulse 2D rigid-body physics engine. */
export { AABB } from './aabb';
export { Body, BodyType, type BodyDef } from './body';
export { BroadPhase, DynamicTree, type ProxyPair } from './broadphase';
export { gjkDistance, epaPenetration, type DistanceResult, type PenetrationResult } from './collision/gjk';
export { collide, type Manifold, type ManifoldPoint } from './collision/manifold';
export { timeOfImpact, type TOIResult } from './collision/toi';
export { Contact, ContactSolver, DEFAULT_CONFIG, solveBlockLcp, type SolverConfig } from './contact';
export { BuoyancyZone, type BuoyancyDef } from './fluid';
export {
  clamp,
  crossSV,
  crossVS,
  EPSILON,
  lerp,
  Mat22,
  Rot,
  Transform,
  Vec2,
} from './math';
export { Rng } from './random';
export {
  boundingRadius,
  Capsule,
  Circle,
  computeAABB,
  computeMass,
  convexHull,
  convexProxy,
  Polygon,
  polygonCentroid,
  shapeRadius,
  shapeSupport,
  type ConvexProxy,
  type MassData,
  type Shape,
} from './shapes';
export { World, type RayHit, type ShapeCastHit, type StepStats, type FractureFlash } from './world';

export {
  clipHalfPlane,
  polygonArea,
  pointInConvex,
  polygonBounds,
  voronoiCells,
  scatterSites,
  fractureBody,
  fractureMaterial,
  isFracturable,
  shapeMass,
  DEFAULT_FRACTURE,
  type SitePattern,
  type SiteOptions,
  type FractureMaterial,
  type FractureOptions,
} from './fracture';

export {
  collideParticle,
  compliance,
  DEFAULT_SOFT_CONFIG,
  makeBlob,
  makeCloth,
  makeRope,
  makeSoftBox,
  Particle,
  signedArea,
  SoftBody,
  stepSoftBodies,
  type AreaConstraint,
  type BlobOptions,
  type ClothOptions,
  type DistanceConstraint,
  type ParticleHit,
  type RopeOptions,
  type SoftCommon,
  type SoftConfig,
  type SoftKind,
  type SoftRender,
} from './soft';

export {
  FluidParticle,
  FluidSystem,
  fluidParams,
  Kernels,
  SpatialHash,
  type Emitter,
  type FluidParams,
  type FluidStats,
} from './sph';

export { type Joint, type JointContext } from './joints/joint';
export { RevoluteJoint } from './joints/revolute';
export { DistanceJoint } from './joints/distance';
export { WeldJoint } from './joints/weld';
export { MouseJoint } from './joints/mouse';
export { PrismaticJoint } from './joints/prismatic';
export { WheelJoint } from './joints/wheel';
export { PulleyJoint } from './joints/pulley';
export { MotorJoint } from './joints/motor';
export { GearJoint, type GearableJoint } from './joints/gear';
