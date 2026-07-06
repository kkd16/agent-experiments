// Shared types for the Event Horizon renderer.
//
// Units convention throughout the app: the Schwarzschild radius rs = 1, so the mass
// parameter M = rs/2 = 0.5, the photon sphere sits at r = 1.5, the ISCO at r = 3, and the
// critical impact parameter (photon capture) is b_crit = 3·√3·M ≈ 2.598.

/** Every knob that controls the 3D render. Kept flat + serialisable so presets are trivial. */
export interface Params {
  /** Camera distance from the singularity, in rs units. */
  cameraDistance: number
  /** Camera elevation above the disk's equatorial plane, in degrees (0 = edge-on, 90 = top-down). */
  inclination: number
  /** Camera orbital angle around the hole, in degrees. */
  azimuth: number
  /** Vertical field of view, in degrees. */
  fov: number
  /**
   * Put the camera on an infalling Gullstrand–Painlevé "rain" geodesic. Every camera ray is
   * relativistically aberrated and the whole image is Doppler-beamed as it would be for an
   * observer that fell from rest at infinity — the sky compresses and blueshifts ahead of you.
   */
  freeFall: boolean

  /** Dimensionless spin a/M ∈ [0, 0.998]. 0 = Schwarzschild, 1 = extremal Kerr. */
  spin: number
  /** Draw the ergosphere (static limit) as a translucent shell in the Kerr render. */
  ergosphere: boolean
  /** When on, the disk's inner edge snaps to the prograde ISCO for the current spin. */
  iscoTrack: boolean

  /** Inner edge of the accretion disk, in rs units (physical ISCO is 3). */
  diskInner: number
  /** Outer edge of the accretion disk, in rs units. */
  diskOuter: number
  /** Overall disk emission multiplier. */
  diskBrightness: number
  /** Peak black-body temperature scale at the inner edge (arbitrary, mapped to a Planckian ramp). */
  diskTemperature: number
  /** Disk opacity/density — higher values make the disk more solid. */
  diskDensity: number
  /**
   * Ray-march the disk as a finite-thickness, self-shadowing volume instead of an infinitely thin
   * plane. Slower but far more three-dimensional. When off, the crisp thin-plane path is used.
   */
  volumetric: boolean
  /** Half-thickness scale of the volumetric disk at its inner edge, in rs (the slab flares outward). */
  diskThickness: number

  /** Number of RK4 integration steps per photon (quality vs. speed). */
  steps: number
  /** Base integration step size (multiplied by an adaptive, distance-dependent factor). */
  stepSize: number

  /** Relativistic Doppler beaming of the orbiting disk material. */
  doppler: boolean
  /** Gravitational + transverse redshift of the disk. */
  redshift: boolean

  /** Brightness of the lensed background starfield. */
  starBrightness: number
  /** HDR exposure applied before the ACES tonemap. */
  exposure: number

  /** Multi-pass HDR bloom on the disk highlights. */
  bloom: boolean
  /** Bloom intensity (how much of the blurred bright-pass is added back). */
  bloomStrength: number
  /** Luminance above which a pixel contributes to the bloom. */
  bloomThreshold: number

  /** Internal render resolution scale (0.35–1). Lower = faster. */
  renderScale: number
  /** Auto-tune renderScale to hold a target framerate. */
  adaptiveQuality: boolean
  /** Slowly orbit the camera on its own. */
  autoRotate: boolean
}

export interface Preset {
  name: string
  blurb: string
  params: Partial<Params>
}

export type ViewId = 'render' | 'geodesics' | 'observatory' | 'about'
