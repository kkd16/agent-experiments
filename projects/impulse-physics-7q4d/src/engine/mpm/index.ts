/** Public surface of the Material Point Method (MLS-MPM) subsystem. */
export { Mat2, svd2, polarR, type Svd2 } from './mat2';
export {
  MATERIALS,
  material,
  lame,
  corotatedPF,
  evaluate,
  type MpmModel,
  type MpmMaterial,
  type Lame,
  type StressResult,
} from './material';
export {
  MpmSystem,
  MpmParticle,
  mpmParams,
  type MpmParams,
  type MpmStats,
} from './mpm';
