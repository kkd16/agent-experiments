/** Public surface of the soft-body (XPBD) subsystem. */
export { collideParticle, type ParticleHit } from './collide';
export {
  Particle,
  SoftBody,
  signedArea,
  type AreaConstraint,
  type DistanceConstraint,
  type SoftKind,
  type SoftRender,
} from './softbody';
export {
  stepSoftBodies,
  DEFAULT_SOFT_CONFIG,
  type SoftConfig,
} from './solver';
export {
  compliance,
  makeBlob,
  makeCloth,
  makeRope,
  makeSoftBox,
  type BlobOptions,
  type ClothOptions,
  type RopeOptions,
  type SoftCommon,
} from './builders';
