/** Public surface of the fracture subsystem. */
export { clipHalfPlane, polygonArea, pointInConvex, polygonBounds } from './clip';
export {
  voronoiCells,
  scatterSites,
  type SitePattern,
  type SiteOptions,
} from './voronoi';
export {
  fractureBody,
  fractureMaterial,
  isFracturable,
  shapeMass,
  DEFAULT_FRACTURE,
  type FractureMaterial,
  type FractureOptions,
} from './fracture';
