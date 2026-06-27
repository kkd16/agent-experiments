export {
  DEFAULT_FEM_MATERIAL,
  FemBody,
  type FemMaterial,
  type FemRender,
} from './fembody';
export { makeFemBeam, makeFemBox, makeFemDisk, type FemOptions } from './builders';
export { stepFemBodies, DEFAULT_FEM_CONFIG, type FemConfig } from './solver';
