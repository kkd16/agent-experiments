# Lumen — journal

The app's long-lived memory. Read this first when you pick it back up.

**Lumen** is a from-scratch, physically based **Monte-Carlo path tracer** that runs entirely on
the CPU (no WebGL/WebGPU) across a Web Worker pool, rendering into a `<canvas>` with progressive
accumulation. It solves the rendering equation with next-event estimation + multiple importance
sampling, GGX microfacet BSDFs, smooth **and frosted** dielectrics, **spectral dispersion**,
**subsurface scattering** (random-walk translucency for marble/jade/wax/skin),
**Beer–Lambert volumetric absorption**, **heterogeneous participating media** (procedural fBm
clouds, smoke & fog traced by **delta/ratio tracking**), **procedural textures**, **adaptive
variance-guided sampling** with a live noise heatmap, a SAH BVH, ACES tone mapping, and an
edge-avoiding À-Trous denoiser. It carries **four interchangeable light-transport integrators** (a unidirectional path
tracer, bidirectional PT, primary-sample-space Metropolis, and stochastic progressive photon
mapping) that all provably converge to the same image — and as of 8.0 the photon mapper is
**spectral** (rainbow caustics through dispersive glass) and **daylight-complete** (the sun is a
photon emitter, so daylight scenes get photon-mapped sun caustics).

## Architecture

- `src/engine/vec3.ts` — vector algebra, ONB (Duff 2017), reflect/refract.
- `src/engine/rng.ts` — sfc32 RNG + splitmix32 seeding; cosine/disk/GGX samplers; power heuristic.
- `src/engine/ray.ts` — rays, AABB slab test, hit record.
- `src/engine/material.ts` — the **physically based material system**. Lambert / GGX metal (VNDF
  sampling, Smith G2) / smooth + rough dielectric (exact Fresnel, microfacet refraction) / emissive,
  plus (11.0) **real metals from measured complex IOR** (η(λ),k(λ) tables + exact conductor Fresnel
  at the hero wavelength, so gold/copper/silver get their physical spectral hue — see `conductor.ts`),
  plus (10.0) **energy-conserving rough metal** (Kulla–Conty multiscatter compensation off a
  start-up-built GGX directional-albedo table `E(μ,α)`/`Eavg(α)`), **anisotropic GGX** (two roughness
  axes in a rotatable tangent frame), **Oren–Nayar** rough-diffuse (`sigma`), and a **clear-coat**
  layer (`coat`: a GGX dielectric gloss over a Lambert/Oren–Nayar base). `sampleBSDF`/`evalBSDF`/
  `pdfBSDF` are kept in lockstep through shared local-frame helpers so every lobe is MIS-consistent;
  `resolveMaterial` bakes textures + dispersion at a vertex. **(12.0)** a dielectric may carry a
  `Subsurface { sigmaT, albedo, g }` `interior`, making it a **translucent solid** the integrator
  random-walks inside (marble/jade/wax/skin).
- `src/engine/texture.ts` — procedural world-space textures (checker / grid / value-noise marble).
- `src/engine/spectrum.ts` — Cauchy dispersion IOR + white-point-normalised wavelength→RGB.
- `src/engine/conductor.ts` — **(11.0)** measured complex refractive indices η(λ),k(λ) for six real
  metals (gold/silver/copper/aluminium/iron/chromium), the exact unpolarised conductor Fresnel, its
  hemispherical average (for Kulla–Conty), and a band-integrated RGB F0 (denoiser/BDPT fallback).
- `src/engine/primitive.ts` — sphere + triangle (Möller–Trumbore w/ barycentrics + smooth
  vertex normals), triangle area-light sampling, degenerate-thin AABB padding.
- `src/engine/mesh.ts` — indexed mesh generators (icosphere / uv-sphere / torus / surface of
  revolution), affine transforms (inverse-transpose normals), area-weighted normal recovery.
- `src/engine/obj.ts` — Wavefront OBJ parser (v/vn/f, polygon fans, auto-fit to a unit box).
- `src/engine/noise.ts` — dependency-free 3D value noise + fBm + domain warp (the density fields).
- `src/engine/volume.ts` — compiles a `DensityDef` into a `DensityField` (majorant + density(p)) for
  heterogeneous media; FBM clouds/smoke + exponential fog layers, bounded by the medium sphere.
- `src/engine/sky.ts` — Preetham analytic daylight (Perez distribution + zenith chromaticity).
- `src/engine/bvh.ts` — binned SAH build, stack traversal (nearest + any-hit).
- `src/engine/scene.ts` — scene assembly, intersection, NEE light sampler + MIS light pdf, env,
  and the participating-media estimators: analytic Beer–Lambert for homogeneous volumes, **delta
  tracking** (free-flight collisions) + **ratio tracking** (shadow transmittance) for heterogeneous.
- `src/engine/integrator.ts` — the path tracer: NEE + MIS (power heuristic) + Russian roulette,
  Beer–Lambert medium tracking, hero-wavelength spectral sampling, and **(12.0)** the **subsurface
  random walk** (a homogeneous interior free-flight + HG phase scatter bounded by the dielectric
  surface, entered/exited through its Fresnel interface).
- `src/engine/bdpt.ts` — bidirectional path tracer: camera×light subpath connections weighted by
  balance-heuristic MIS; exports `areaDensity`/`misPartitionResidual` for the proofs.
- `src/engine/pssmlt.ts` — Primary-Sample-Space Metropolis light transport: a `PssmltSampler`
  (an `Rng` subclass that returns coordinates of a mutatable random-number vector) lets the path
  tracer be reused *verbatim* as the contribution function; `MltState` runs the Markov chain
  (Kelemen lazy mutation, expected-value splatting, bootstrap brightness) and is driven by both the
  worker and the single-thread fallback.
- `src/engine/sppm.ts` — stochastic progressive photon mapping: an `SppmState` (same
  `FrameEstimator` shape as `MltState`) that, each pass, re-traces jittered camera rays to place a
  per-pixel measurement point, emits power-sampled photons from the area lights, deposits them into
  the measurement points via an exact `HashGrid` (CSR spatial hash), and shrinks each point's gather
  radius on the Hachisuka schedule so the density estimate converges. Built for caustics. As of 8.0
  its photons are **spectral** (commit a hero wavelength on the first dispersive hit → rainbow
  caustics) and the **sun is a photon source** (a disc, sized to the scene's bounding sphere,
  perpendicular to the sun → daylight caustics + GI), both unbiased and proven in the verify suite.
- `src/engine/tonemap.ts` — ACES / filmic / Reinhard / linear + sRGB encode.
- `src/engine/denoise.ts` — À-Trous edge-avoiding wavelet filter, albedo/normal guided.
- `src/engine/scenes.ts` — Cornell box, Weekend daylight, Material gallery, **Brushed Metal**
  (anisotropic GGX), **Rough Conductors** (single-scatter vs Kulla–Conty multiscatter split),
  **Ceramics & Clay** (clear-coat gloss + Oren–Nayar matte), **Subsurface Studio** + **Jade Idol**
  (12.0 translucent marble/jade/wax/skin), Caustic room, Caustic Pool
  (rippled-water caustics), Prism (dispersion), Glass Menagerie (roughness + absorption), Textured
  Studio (procedural textures), Cathedral / Nebula (media), Iridescence (thin film), …
- `src/engine/selftest.ts` — invariant checks (furnace, BVH-vs-brute-force, pdf consistency…).
- `src/render/worker.ts` — one render worker owning a horizontal band.
- `src/render/renderer.ts` — worker-pool orchestrator + single-thread fallback + compositing.
- `src/App.tsx` + `src/ui/` — the studio UI (orbit camera, controls, stats, verify, about).

## Ideas / backlog

- [x] Vec / RNG / sampling core
- [x] GGX VNDF microfacet metal + smooth dielectric + Fresnel
- [x] SAH BVH (build + nearest + shadow traversal)
- [x] Path tracer with NEE + MIS + Russian roulette
- [x] Multi-threaded worker pool + progressive accumulation
- [x] Single-thread sandbox fallback (for the catalog thumbnail)
- [x] ACES tone mapping + exposure + operators
- [x] À-Trous albedo/normal-guided denoiser
- [x] Orbit camera, depth of field, 4 preset scenes
- [x] In-app verification suite + PNG export
- [x] Procedural textures — world-space checker / grid / marble (value-noise fBm) albedo
- [x] Rough (microfacet) dielectric — GGX VNDF reflect/refract for frosted glass
- [x] Beer–Lambert volumetric absorption — physically coloured thick glass
- [x] Spectral rendering / dispersion through glass — hero-wavelength Cauchy IOR, prism rainbows
- [x] Adaptive sampling guided by per-pixel variance + live noise (relative-error) heatmap
- [x] Three new scenes: Prism, Glass Menagerie, Textured Studio
- [x] Eight new correctness proofs in the verification suite for the above
- [x] Triangle meshes with smooth (barycentric-interpolated) vertex normals
- [x] Procedural mesh library — icosphere, UV-sphere, torus, surface-of-revolution
- [x] OBJ import (paste-in) with area-weighted normal recovery + auto-fit
- [x] Physically based **Preetham sky** (turbidity + sun position)
- [x] **Environment / sun next-event estimation** — the sky is now a sampled light (MIS)
- [x] **Bidirectional path tracing (BDPT)** — full Veach/Guibas connections + balance-heuristic MIS
- [x] **A physically based material system (10.0)** — the surfaces made as rigorous as the transport:
  - [x] **Energy-conserving rough metal (Kulla–Conty multiscatter)** — a start-up-built GGX
        directional-albedo table `E(μ,α)` drives a compensation lobe that restores the energy the
        single-scatter lobe drops between microfacets, so rough conductors stop darkening; proven to
        reflect ≈1 in a white furnace with compensation and measurably less without
  - [x] **Anisotropic GGX (brushed metal)** — two roughness axes `(αₓ,α_y)` in a rotatable tangent
        frame; anisotropic D, Smith Λ and VNDF sampling; reciprocity + energy preserved exactly
  - [x] **Oren–Nayar rough diffuse** — reciprocal microfacet-diffuse BRDF (`sigma`) for chalk/clay/
        plaster, reducing to Lambert at σ=0
  - [x] **Clear-coat layered materials** — a GGX dielectric coat over a Lambert/Oren–Nayar base
        (`coat`), the two lobes sampled by Fresnel weight with a combined pdf so it stays energy-
        conserving *and* MIS-consistent (matches BDPT pixel-for-pixel)
  - [x] Three showcase scenes — **Brushed Metal**, **Rough Conductors**, **Ceramics & Clay**
  - [x] Six new correctness proofs (GGX albedo table, multiscatter energy, anisotropic reciprocity/
        streak, Oren–Nayar reciprocity/grazing, clear-coat reciprocity/gloss/energy) + a BDPT≡PT
        oracle over a box of all four new materials (55 proofs total)
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)
- [x] **Spectral/Fresnel-conductor reflectance (11.0)** — wavelength-dependent complex IOR (real gold's hue
      from η,k) layered onto the new multiscatter conductor. Measured η(λ)/k(λ) tables for gold, silver,
      copper, aluminium, iron & chromium; exact unpolarised conductor Fresnel evaluated at the path's
      committed hero wavelength (so a metal's hue emerges spectrally, like dispersion); rides on the
      single-scatter, anisotropic *and* Kulla–Conty multiscatter lobes through a shared `FresnelSpec`.
      New **Metals of the World** scene + six proofs (range, k→0 dielectric limit, textbook colours,
      a furnace render reconstructing the measured RGB, MIS sampler↔pdf↔weight, multiscatter energy).
- [ ] **Anisotropic clear-coat & dielectric multiscatter** — extend energy compensation to rough glass
- [x] **Subsurface scattering (12.0)** — random-walk volumetric transport *inside* a translucent
      dielectric (marble/jade/wax/skin): a `Subsurface { sigmaT, albedo, g }` interior, an interior
      free-flight + HG phase walk bounded by the real surface, Fresnel-boundary entry/exit + TIR.
      Two scenes (**Subsurface Studio**, **Jade Idol**) + five proofs (pure-scatter furnace ≡ 1 ∀g,
      pure-absorb ≡ e^(−σ·2r), whole-object Fresnel+TIR+scatter energy ≡ 1, per-channel albedo R>G>B,
      reflectance strictly monotone in albedo).
- [ ] **Subsurface NEE through the boundary** — importance-sample a light *and* the refraction toward
      it (a refracted-shadow connection) to kill the phase-only glow's variance
- [ ] **Separable BSSRDF / diffusion-dipole fast-path** — for very dense media the random walk samples
      poorly at low depth; a diffusion approximation would converge the deep-scatter look in O(1) bounces
- [ ] **Spectral (per-channel σ_t) subsurface** — vary the *mean free path* with wavelength via the
      hero-wavelength machinery (real skin: red penetrates far, blue barely at all), not just the albedo
- [x] **Participating media** — bounded homogeneous volumes with Henyey–Greenstein
      scattering, distance sampling, in-scattering NEE + phase-function MIS (fog, smoke, god rays)
- [x] **Thin-film interference** — spectral Airy reflectance for iridescent coatings
      (soap-bubble / oil-slick / beetle-shell colour from interference, via the hero-wavelength path)
- [x] **Low-discrepancy (quasi-Monte-Carlo) primary sampling** — scrambled Halton
      sequence with Cranley–Patterson rotation for the camera sub-pixel + lens dimensions
- [x] **Primary-Sample-Space Metropolis Light Transport (PSSMLT)** — a third integrator: a
      Markov chain over the path tracer's random stream (Kelemen mutation + Metropolis–Hastings),
      with bootstrap normalisation, parallel chains across the worker pool, and three new proofs
      that it converges to the same image as PT/BDPT
- [x] **Stochastic Progressive Photon Mapping (SPPM)** — a fourth integrator built for **caustics**
      (light→specular→diffuse paths NEE can't sample): photons emitted from the area lights (power-
      sampled, equal flux), traced through the specular geometry, and gathered at per-pixel
      measurement points through an exact spatial hash, with a per-point gather radius shrunk on the
      Hachisuka schedule so the density-estimation bias vanishes and the estimate converges. Slots
      into the full-frame estimator path (like PSSMLT); a new **Caustic Pool** scene (a sine-ripple
      water surface with analytic smooth normals) showcases it; three new proofs (SPPM≡PT oracle,
      caustic-forms, and the gather grid is exact vs brute force)
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)
- [ ] **Photon-map progress-radius decoupling** — share one radius across all workers' passes
      (a single global SPPM rather than averaged independent ones) for slightly faster convergence
- [ ] **Volumetric photon mapping / beam radiance estimate** — let SPPM resolve *volumetric*
      caustics (light focused inside fog) by depositing photons along medium free-flights
- [x] **Spectral photons (8.0)** — a photon commits a random hero wavelength on its first dispersive
      hit and carries that wavelength's RGB weight, so its refraction bends per-colour and the caustic
      it deposits is a *rainbow*. E_λ[weight]=(1,1,1) keeps the total energy exact (proven). Showcased
      by the new **Spectral Caustic** scene.
- [x] **Environment photon emission (8.0)** — the sun (a daylight-gradient sun or a Preetham sky) is
      now a photon source: photons leave a disc sized to the scene's bounding sphere, perpendicular to
      the sun, and rain in as a parallel beam, so daylight scenes get photon-mapped **sun caustics** and
      indirect light. The distant-light flux normalisation S = L·ΣW/lum(L_rep) is proven against the
      path tracer. Showcased by the new **Daylight Lens** scene.
- [ ] Replica-exchange / population MLT — couple PSSMLT chains at different temperatures so a hot
      chain that finds new light hands its discovery to the cold (image) chain
- [ ] A "transport explorer" debug view that visualises which integrator each pixel favours, and
      an A/B equal-time split-screen of PT vs BDPT vs PSSMLT vs SPPM to make the variance gap visible
- [ ] Multiplexed MLT (Hachisuka et al.) — let the chain mutate *which* BDPT strategy it uses, so
      one estimator adapts per-path instead of fixing PT vs BDPT up front
- [ ] Stratified large-step pixel selection so PSSMLT's global jumps cover the film evenly
- [x] **Heterogeneous participating media (9.0)** — procedural 3D density fields (FBM
      cumulus clouds, rising smoke plumes, exponential ground-fog layers) sampled with
      **delta tracking** (Woodcock null-collision free-flight) for in-volume scatter events
      and **ratio tracking** for the shadow-ray transmittance, both provably unbiased for an
      arbitrary spatially varying extinction. Three showcase scenes + five new proofs.
- [ ] **Spectral / chromatic majorants for heterogeneous media** — per-channel σ_t fields
      (today the field is a scalar density × a coloured albedo) with hero-wavelength delta tracking
- [x] **Emissive volumes (9.1)** — a density-modulated emission term in the medium: at a real
      collision the path collects `(1−albedo)·Lₑ` of self-radiance, so a heterogeneous field glows
      brightest in its dense core (fire / embers / luminous nebula). New **Ember** scene + a proof
      that an absorbing+emitting volume obeys `(1−e^(−σ_t·chord))·Lₑ`.

## Roadmap — 2026-06-23 Lumen 12.0: subsurface scattering (claude)

Lumen could render light bouncing *off* a surface (every BRDF), light *through*
clear glass (dielectrics), and light scattering in *unbounded* fog (the global
participating media). The one regime it could not render is the one most physical
objects actually live in: light that enters a solid, bounces around among
microscopic scatterers, and re-emerges somewhere else — **subsurface scattering**.
It is why marble glows, why a hand held to the sun goes red at the edges, why wax,
jade, milk and skin look *soft* in a way no surface shader can fake. A dielectric
in Lumen only did Beer–Lambert absorption inside (a straight-line attenuation); it
never *scattered* internally. 12.0 closes that gap, and does it by **reusing what
was already there** — the volume distance sampler, the Henyey–Greenstein phase
function, and the exact dielectric Fresnel/refraction interface — so the addition
is small, gated and provable, and every one of the 61 prior proofs stays green.

Why it slots in cleanly: random-walk subsurface scattering *is* volumetric path
tracing, but bounded by the object's surface instead of a fog sphere, and entered
only by refracting through a Fresnel boundary. The path already tracks which
dielectric it is "inside" (for Beer–Lambert); 12.0 lets that interior be a
*scattering* medium and runs the same homogeneous free-flight the global media use
— collision ⇒ β ×= albedo + phase-sample; no collision ⇒ reach the boundary with
weight 1 and let the surface BSDF refract it out or trap it by TIR. Nothing else
in the transport loop changes.

Plan / steps (all shipped this session):

1. **`material.ts` — a `Subsurface { sigmaT, albedo, g }` interior.** Added an
   optional `interior` field to the dielectric. Present ⇒ translucent solid;
   absent ⇒ ordinary glass. `resolveMaterial` already spreads the dielectric, so
   dispersion + subsurface compose; `isDelta`/`isSpectral` unchanged.
2. **`integrator.ts` — the interior random walk.** A new `sss` path-state variable,
   set/cleared on the dielectric transmission event (mirroring the existing
   Beer–Lambert `medium` toggle). While non-null, a homogeneous free-flight runs
   *before* surface shading: a real collision scatters via `sampleHG` (β ×= albedo,
   the absorbed fraction 1−albedo darkening with depth); no collision falls through
   to shade the boundary with unit weight. Phase-only, no interior NEE — flagged so
   the eventual exit-to-light is MIS-counted in full. The global-media block is
   gated `&& !sss` so the two estimators never both fire.
3. **`scenes.ts` — two showcase scenes.** **Subsurface Studio** (back-lit marble/
   jade/honey-wax/rose spheres) and **Jade Idol** (a watertight surface-of-
   revolution lathe in jade). A `translucent()` builder keeps `tint` white so the
   colour comes purely from the interior albedo.
4. **`selftest.ts` — five proofs** (a shared `subsurfaceFurnaceRGB` harness):
   pure-scatter furnace ≡ 1 ∀g (zero-variance energy conservation + unbiased phase
   walk); pure-absorb ≡ e^(−σ·2r) (Beer's law from the free-flight); the whole
   object (Fresnel + TIR + scatter) ≡ 1; per-channel albedo tints R>G>B, bounded ≤1;
   and reflectance strictly monotone in the interior albedo (0.3→0.6→0.9, ≤1).

Next (open): subsurface NEE through the boundary (importance-sample a light *and*
the refraction toward it) to denoise the glow; a separable BSSRDF / diffusion
dipole fast-path for highly scattering media that the random walk samples poorly at
low depth; spectral (per-channel σ_t) interiors via the hero-wavelength machinery,
so the *mean free path* — not just the albedo — varies with colour (true skin);
and volumetric SSS in the photon mapper for inner caustics.

## Roadmap — 2026-06-21 Lumen 11.0: real metals from measured complex IOR (claude)

10.0 made Lumen's *surfaces* as rigorous as its transport — but it left one
asymmetry standing. Every "metal" was still tinted by an RGB `albedo` fed into the
**Schlick** Fresnel approximation as F0. That is convenient and wrong: a real
conductor's colour is not a pigment, it is a **spectral reflectance** R(λ) fixed by
its complex refractive index `n̄(λ) = η(λ) − i·k(λ)`. That spectral shape is exactly
what makes gold warm, copper red, silver brilliant-neutral and aluminium faintly
blue — and Schlick-from-RGB can fake the colour head-on but gets the *angular*
desaturation wrong and can never reproduce the hue shift toward the horizon. 11.0
closes that last gap: metals are now driven by **measured η/k spectra** and the
**exact unpolarised conductor Fresnel**, reusing the hero-wavelength machinery that
already disperses glass — so the additions are small, gated and provable, and every
one of the 55 existing proofs stays bit-for-bit green.

Why this slots in cleanly: a path that strikes a *spectral* surface already commits
one **hero wavelength** and scales β by the white-point-normalised RGB weight
(`wavelengthWeight`, with `E_λ[weight]=(1,1,1)`). A spectral metal joins that club:
at the committed λ the conductor reflects a single *scalar* fraction `R(λ,θ)`, so the
lobe shades grey and the metal's colour reconstructs over wavelengths — exactly as a
prism's rainbow does. Nothing in the transport loop changes; only the Fresnel does.

Plan / steps (all shipped this session):

1. **`conductor.ts`** — measured complex refractive index η(λ),k(λ) for six metals
   (gold/silver/copper — Johnson & Christy 1972; aluminium — Rakić 1998; iron &
   chromium — handbook), sampled across 400–700 nm and linearly interpolated. The
   **exact unpolarised conductor Fresnel** `fresnelConductor(cosθ,η,k)` (PBRT's
   `FrComplex`, real-valued s+p average); the cosine-weighted hemispherical average
   `conductorAverageFresnel` (no closed form for a complex index, so integrated) for
   Kulla–Conty; and a band-integrated `conductorF0RGB(name)` (the RGB a head-on
   spectral path converges to) for the denoiser guide and the achromatic fallback.
2. **`material.ts` — a shared `FresnelSpec`.** Every microfacet lobe used to call
   `fresnelSchlick(cos, f0)` directly. They now route through `fresnelSpec(cos, fr)`
   where `fr` is *either* `{f0}` (Schlick) *or* `{eta,k,favg}` (a baked conductor),
   so a metal can be spectral, anisotropic and multiscatter-compensated at once and
   no lobe ever branches on which Fresnel it carries. `metalMsFLocal` takes the spec
   and uses the matching hemispherical average, so spectral metals are energy-
   compensated correctly. Non-spectral metals hit the identical Schlick path →
   bit-for-bit unchanged.
3. **The metal material gains `spectrum?: ConductorName`** (public, scene-facing) and
   an internal baked `cond?: {eta,k,favg}`. `isSpectral` is true for a spectrum
   metal, so the integrator commits a hero wavelength on first contact;
   `resolveMaterial` bakes (η,k) + the average at that λ. At λ=0 (the achromatic BDPT
   path) `cond` is left unset and the lobe falls back to Schlick(albedo), where
   `albedo = conductorF0RGB(name)` already carries the right colour — so BDPT and the
   denoiser stay sensible without spectral support.
4. **Scene — Metals of the World.** The six conductors as a front row of glossy
   spheres under the Preetham sky (warm sun + broad skylight reveal each hue), with a
   back row composing the new Fresnel with the *other* upgrades: brushed (anisotropic)
   gold, multiscatter-compensated rough copper, a smooth silver mirror.
5. **UI / About.** A "Real metals (complex IOR)" card explaining n̄=η−ik, the
   hero-wavelength reconstruction and the angular desaturation Schlick misses.
6. **Six proofs (61 total).** (a) conductor Fresnel R∈[0,1] for every metal/λ/angle
   and →1 at grazing; (b) the **k→0 limit reduces exactly to the dielectric Fresnel**
   (max error < 1e-9 — the complex formula pinned against the real one); (c) the
   measured spectra reproduce the **textbook colours** (Au/Cu warm with R>G>B, Ag/Al
   bright-neutral, Fe/Cr flat grey — a guard against η/k transcription slips that the
   energy tests would miss); (d) the **headline white-point oracle** — a smooth gold
   sphere rendered with the hero-wavelength path tracer in a unit furnace reconstructs
   `conductorF0RGB('gold')` to <0.02 per channel (η/k → hero λ → wavelengthWeight →
   image, end to end); (e) **MIS consistency** — after `resolveMaterial` bakes (η,k),
   the rough conductor's sampler↔pdf agree (<1e-5) and weight == f·cosθ/pdf (<1e-4),
   for the plain GGX *and* the multiscatter lobe; (f) **spectral multiscatter energy**
   — a rough gold lobe with compensation reflects more than single-scatter yet never
   exceeds its hemispherical-average reflectance F̄ (restored, not invented). Verified
   in Node by bundling the engine: 61/61 self-tests + a Metals smoke render (all
   finite, lit, chromatic). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-20 Lumen 10.0: a physically based material system (claude)

For nine versions Lumen poured enormous rigour into *light transport* — four
integrators that provably agree, spectral and daylight photons, null-collision
volumetrics — while the **surfaces** stayed deliberately small: Lambert, a
single-scatter GGX metal, dielectric glass, a thin film. That asymmetry showed:
a rough gold sphere went *grey* (single-scatter GGX drops the energy that should
bounce between microfacets), every metal highlight was an isotropic blob, matte
clay looked like plastic, and there was no glazed/ceramic/car-paint look at all.
10.0 closes the gap with a proper material system, built so each new lobe is as
provably correct as the transport that carries it.

**1 — Energy-conserving rough metal (Kulla–Conty multiscatter).** A single-scatter
microfacet lobe reflects only `E(μ,α)` of the incident energy (the rest would
have taken a second, third… bounce between microfacets and is simply dropped), so
conductors darken and desaturate as they roughen. We Monte-Carlo–integrate the
GGX *directional albedo* `E(μ,α)` (and its hemisphere average `Eavg(α)`) into a
32×32 table **once at start-up** — reusing the fact that the VNDF throughput for a
white lobe is exactly `G2/G1`, so the table is the very quantity the furnace test
measures — then add a compensation lobe
`f_ms = F_ms·(1−E(μₒ))(1−E(μᵢ)) / (π(1−Eavg))` that integrates to exactly the
missing `(1−E(μₒ))`. A coloured multiscatter Fresnel
`F_ms = Favg²·Eavg/(1−Favg(1−Eavg))` keeps saturated metals saturated. The result
is energy-exact for white (furnace ≈ 1) and a `multiscatter` flag on the metal
material turns it on. **Verify** proves a white rough conductor reflects ≈1 with
compensation and noticeably less without.

**2 — Anisotropic GGX (brushed/milled metal).** Generalised the distribution,
Smith masking and VNDF sampler to two roughness axes `(αₓ,α_y)` (Disney's
`aspect = √(1−0.9·aniso)`) expressed in a tangent frame the material can rotate
(`anisoAngle`). The isotropic case reduces to the old formulae *exactly*
(verified algebraically and numerically), so existing metals are untouched. The
half-vector reflection keeps `wo·h = wi·h`, so the BRDF is exactly reciprocal —
proven, alongside an energy bound and a measurable pdf "streak" between the two
tangent axes.

**3 — Oren–Nayar rough diffuse.** The reciprocal qualitative Oren–Nayar model
(`sigma`) for chalk, clay, plaster and lunar regolith — surfaces whose microscopic
roughness makes them flatten and back-scatter toward the light. Reduces to Lambert
at σ=0; proven reciprocal and proven to exceed Lambert in the grazing
retro-reflection regime where its `B` term lives.

**4 — Clear-coat layered materials.** Glazed ceramic, lacquer and car paint: a
clear GGX *dielectric coat* over a Lambert/Oren–Nayar base. The coat reflects a
Fresnel fraction as a gloss lobe and transmits the rest to the base, attenuated by
`(1−F(μₒ))(1−F(μᵢ))` so the stack conserves energy and stays reciprocal. The coat
and base lobes are sampled stochastically by a Fresnel-driven probability with a
*combined* pdf, so the material is MIS-consistent — it matches BDPT pixel-for-pixel.

**Plumbing & proofs.** All four are added without a single new `Material` *kind*
— they ride as optional fields on `diffuse`/`metal`, so the integrators' switches
and BDPT/SPPM are untouched; the shared local-frame helpers
(`ggxReflectFLocal`/`…PdfLocal`, anisotropic variants, `metalMsFLocal`,
`diffuseLayeredFLocal`) guarantee `sample`/`eval`/`pdf` can never drift apart.
Three showcase scenes — **Brushed Metal**, **Rough Conductors** (a single-scatter
vs multiscatter split), **Ceramics & Clay** — and **six** new proofs (GGX albedo
table monotonicity, multiscatter energy restoration, anisotropic reciprocity +
streak, Oren–Nayar reciprocity + grazing, clear-coat reciprocity + gloss + energy)
plus a **BDPT≡PT oracle** over a box of all four materials. Verified in Node by
bundling the engine and running all **55** self-tests (55/55) + a render smoke
test of the three new scenes (no NaNs, all lit); `pnpm lint`/`tsc`/`build` green
via the CI gate.

## Roadmap — 2026-06-20 Lumen 9.0: heterogeneous participating media — clouds, smoke & fog via delta/ratio tracking (claude)

Lumen 4.0 made the *space between surfaces* physical, but only as **homogeneous**
volumes: a medium was a sphere of *constant* extinction, so every "cloud" was a
uniformly-foggy ball. Real clouds, smoke and ground fog are **heterogeneous** —
their density varies continuously through space — and the unbiased way to trace
light through a varying extinction field is the **null-collision** family of
estimators (Woodcock 1965; Novák et al. 2014). 9.0 adds exactly that: a
procedural 3D density field per medium, **delta tracking** for the free-flight
distance sampler, and **ratio tracking** for the shadow-ray transmittance. The
homogeneous path is untouched (a medium with no `density` field stays analytic),
and because both estimators are unbiased the existing energy-conservation and
transmittance oracles extend to the heterogeneous case as the headline proofs.

Why null-collision tracking is the right tool: you cannot invert the CDF of a
free flight `e^{−∫σ_t ds}` when `σ_t` varies arbitrarily. Delta tracking instead
adds a fictitious "null" collider so the *total* extinction is a constant
majorant `σ̄ ≥ max σ_t`; you sample analytic exponential flights against `σ̄`, and
at each tentative collision flip a coin — a **real** scatter with probability
`σ_t(x)/σ̄`, else a **null** event (continue, unperturbed). The real-collision
distribution is then *exactly* the heterogeneous free-flight law, with no bias
and no integral to evaluate. Ratio tracking is its transmittance cousin: walk
the same majorant flights and multiply by `(1 − σ_t(x)/σ̄)` at each tentative
collision; its expectation is `e^{−∫σ_t ds}` for *any* field — an unbiased
shadow-ray estimator that needed no closed form.

Plan / steps (all to ship this session):

1. **`noise.ts`** — a dependency-free 3D value-noise generator (hashed integer
   lattice, quintic-smoothstep trilinear interpolation) plus fractional Brownian
   motion (`fbm3`, octave sum) and a domain-warp helper for billowy structure.
   Deterministic and allocation-free in the hot loop. (Self-test: bounded,
   continuous, deterministic, ≈zero-mean.)
2. **`MediumDef.density`** (types.ts) — an optional, structured-clone-friendly
   `DensityDef` union: `{kind:'fbm', …}` (cumulus / smoke, with octaves,
   frequency, lacunarity, gain, coverage threshold, a soft spherical edge
   falloff, a vertical density bias and a domain-warp amount) and
   `{kind:'layer', …}` (an exponential vertical fog layer with noise lumpiness).
   Absent ⇒ homogeneous (the 4.0 behaviour, bit-for-bit).
3. **`volume.ts`** — a `DensityField` (`{ majorant; density(p) ∈ [0,1] }`) and
   `makeDensityField(medium)` that compiles a `DensityDef` into an evaluator
   closure bounded by the medium sphere. The field returns a *normalised* density
   in [0,1]; the medium's `sigmaT` is the majorant extinction.
4. **Scene** — precompute `fields[]` parallel to `media[]`; rewrite
   `sampleMediumScatter` to **delta-track** heterogeneous media (analytic
   exponential for homogeneous) and `mediaTransmittance(…, rng)` to **ratio-track**
   them (analytic for homogeneous). Disjoint-media assumption preserved (nearest
   real collision wins).
5. **Integrator** — thread `rng` into the two `mediaTransmittance` calls (the only
   change; the collision branch already multiplies β by the albedo, which is the
   correct delta-tracking real-collision weight, and the camera path still needs
   no transmittance multiply because null collisions leave β unchanged).
6. **Scenes (`scenes.ts`)** — three showcases: **Cumulus** (a sunlit FBM cloud
   under the Preetham sky — forward-scattering silver lining + soft self-shadowing),
   **Smoke Plume** (a rising, dark, vertically-biased FBM column lit from the side),
   **Drifting Fog** (a low exponential ground-fog layer in a colonnade, so the
   skylight breaks into god-rays grazing the fog top). Registered `fog: true`.
7. **UI** — the existing fog-density knob already scales `sigmaT` (= the majorant),
   so it works unchanged; add a **Cloud coverage** control that remaps the FBM
   threshold for heterogeneous scenes, and an About card explaining delta/ratio
   tracking.
8. **Proofs (5 new, 48 total) (`selftest.ts`)** — (a) the noise field is bounded,
   continuous, deterministic and ≈zero-mean; (b) **delta tracking with a constant
   (=1) field reproduces `e^{−σ_t L}`** — the heterogeneous free-flight sampler
   collapses to Beer's law (unbiasedness oracle, mirrors test 24); (c) **ratio
   tracking is an unbiased transmittance estimator** — `E[T̂] = e^{−σ_t L}` for a
   constant field; (d) **ratio tracking matches a genuinely varying analytic
   optical depth** — a `layer` field's transmittance vs a fine deterministic
   quadrature of `∫σ_t ds`; (e) **a heterogeneous pure-scattering volume conserves
   energy** — an FBM medium with albedo 1 in a uniform unit field is still
   invisible (radiance through = 1), the strongest end-to-end oracle for the whole
   delta-tracking integrator.

## Roadmap — 2026-06-19 Lumen 8.0: a spectral, daylight-complete photon mapper (claude)

Lumen 7.0 gave the renderer a fourth integrator — stochastic progressive photon
mapping (SPPM) — built for the one transport the camera-side integrators can't
touch: the **caustic** (a light→specular→diffuse path). But that first photon
mapper was deliberately narrow: it traced photons **achromatically** (so a
caustic through *dispersive* glass came out white, throwing away the rainbow the
path tracer already shows for direct views of a prism), and it emitted photons
**only from the emissive triangles** (so a *daylight* scene — lit by the sun, a
light at infinity — got no photon-mapped caustics at all, because the sun was
never a photon source). 8.0 closes both gaps. The photon mapper is now **colour-
complete** and **daylight-complete**, and it reuses the existing engine
verbatim — the wavelength machinery from the path tracer and the sun model from
next-event estimation — so the additions are small, surgical, and provable.

The plan, all shipped this session:

1. **Spectral photons (`sppm.ts`).** A photon walk now tracks a committed hero
   wavelength exactly as the path tracer does: the first time a photon strikes a
   *spectral* surface (`isSpectral` — dispersive glass or a thin film), it draws a
   uniform wavelength in [380,720] nm and multiplies its flux by that wavelength's
   white-point-normalised RGB weight (`wavelengthWeight`). From then on the
   dielectric's IOR is resolved at that wavelength (`resolveMaterial(.,.,λ)`), so
   blue photons refract more sharply than red and the caustic on the floor fans
   into a spectrum. Because `E_λ[weight] = (1,1,1)`, the *total* deposited energy
   is unchanged — dispersion only spreads it across colour and space — so the
   image stays unbiased. The camera pass commits a wavelength symmetrically, so a
   prism viewed *directly* under SPPM disperses just as it does under PT.

2. **Environment / sun photon emission (`sppm.ts`).** The scene's sun — a
   daylight-gradient sun or a Preetham sky sun, already exposed by `scene.envSun`
   for NEE — joins the photon-source pool. A sun photon is launched by (a) sampling
   a direction toward the sun uniformly in its cone (the exact sampler NEE uses),
   (b) reading the radiance there, and (c) emitting from a uniformly sampled point
   on a disc of radius R (the scene's bounding-sphere radius) one radius out along
   that direction, travelling into the scene as a parallel beam. The per-photon
   flux is derived from the disc-area pdf 1/(πR²) and the cone pdf 1/Ω, and the
   selection weight is the sun's luminous power lum(L_rep)·πR²·Ω, so the πR²·Ω
   geometry **cancels** and the photon flux is `S = L·ΣW/lum(L_rep)` — exactly
   parallel to the triangle case `Le·π·ΣW/lum(Le)`, and unbiased for any choice of
   R. The sun shares the same per-pass photon budget and `N_emit` normaliser as the
   triangle lights, so no other code changes.

3. **Two showcase scenes (`scenes.ts`).** **Spectral Caustic** — a dense,
   dispersive glass sphere and a glass prism over a white catch-floor in a dark
   room, lit by one small panel: under Photon Map the focused caustic is a
   *rainbow*. **Daylight Lens** — a glass sphere and a gold torus on a tiled floor
   under the Preetham sky: the sun, refracted through the glass, focuses a caustic
   on the floor that *only* environment photons resolve (a distant-light
   light→specular→diffuse path NEE can't connect through the lens).

4. **Four new proofs (43 total) (`selftest.ts`).** (a) **Spectral photons conserve
   energy** — a dispersive caustic box rendered with spectral photons ON vs OFF
   agrees on total image energy to ~0.2% (the white-point/normalisation oracle for
   the hero-wavelength photon walk). (b) **The spectral caustic is coloured** — its
   chromatic spread (range of (R−B)/luminance) is large while the achromatic twin
   is exactly grey. (c) **Env-sun photons ≡ the path tracer** — a sun-lit diffuse
   courtyard under SPPM (sun photons) matches PT (sun NEE) in mean brightness to
   ~2.5%, pinning the distant-light flux normalisation. (d) **Env photons resolve a
   daylight caustic** — the sun focuses a spot through a glass sphere measurably
   brighter (≈8.7×) than the directly-lit floor. Verified in Node by bundling the
   engine with Vite: 43/43 self-tests, plus a smoke render of both new scenes
   (all-finite, energetic, with hundreds of chromatic caustic pixels). `pnpm
   lint`/`tsc`/`build` green via the CI gate.

The flux algebra that makes the sun unbiased *for free* is the nicest part: the
distant-light geometry (disc area πR², cone solid angle Ω) appears in both the
photon flux and the selection weight, so it cancels to leave a formula that is the
literal twin of the area-light one — a single code path for "radiance · π · ΣW /
luminance" emits both a lamp and a star correctly.

## Roadmap — 2026-06-16 Lumen 7.0: stochastic progressive photon mapping (SPPM) (claude)

Lumen had three integrators that all *grow paths ending on a light* (PT, BDPT,
PSSMLT). They share one blind spot: the **caustic** — light focused through a
lens/glass onto a diffuse surface, the camera seeing a light→specular→diffuse
(SDS) path. Next-event estimation is useless there (a shadow ray to the lamp
won't refract through the glass, so the light has measure zero), and a diffuse
bounce that threads the lens by luck is astronomically rare — so caustics are
the textbook slow case for all three. 7.0 adds a *fourth* integrator whose whole
job is exactly that transport, by running the light transport **backwards**.

The plan, all shipped this session:

1. **Photons from the lights (`sppm.ts`).** Emit photons from the emissive
   triangles, chosen in proportion to their power so every photon carries equal
   flux `Le·π·Σpower/lum(Le)`; trace them through the scene (reusing
   `Scene.intersect` + the `Material` BSDFs + Beer–Lambert medium tracking
   verbatim), and at every non-specular surface **deposit** them into the nearby
   measurement points. Specular surfaces just refract/reflect — so a photon that
   goes light→glass→floor lands a caustic by *construction*.
2. **Per-pixel measurement points + the progressive radius.** Each pass re-traces
   *jittered* camera rays (Hachisuka & Jensen's *stochastic* PPM — this
   anti-aliases and captures glossy/DoF visible points), follows specular bounces,
   and stores the first non-specular hit as that pixel's measurement point. The
   gathered flux `τ`, photon count `N` and squared radius `R²` persist across
   passes and update on the Hachisuka schedule `N←N+αM`, `R²←R²·(N+αM)/(N+M)`,
   `τ←(τ+Σf·ΔΦ)·R²_new/R²` — which provably drives the density-estimation bias to
   zero, so the estimate **converges** to the true rendering-equation solution.
   Directly-seen emission (incl. through specular glass) is added on the camera
   path; the radiance is `emission/passes + τ/(N_emitted·π·R²)`.
3. **Exact gather via a spatial hash (`HashGrid`).** Each measurement point is
   inserted (CSR-packed in typed arrays, zero per-pass allocation in the hot loop)
   into every grid cell its gather sphere overlaps, so a photon need only probe its
   own cell to find *every* point whose radius could reach it. Hash collisions only
   add a few distance tests — never a miss.
4. **Wiring.** SPPM is a *full-frame estimator* like PSSMLT, so the worker and
   renderer were generalised behind a small `FrameEstimator` interface: each worker
   runs an independent full-frame SPPM and the UI averages the workers' estimates
   weighted by passes. A fourth **Integrator** option ("Photon Map"), the progress
   readout reads "Passes", an About card, the footer.
5. **A showcase scene — Caustic Pool.** A wind-rippled water surface built as a
   sine heightfield with *analytic* smooth normals (a single refractive sheet),
   over a tiled floor lit by an overhead panel: light refracting through the
   undulating surface focuses into the shifting bright filaments of a swimming
   pool — the canonical SDS caustic, which now resolves cleanly under SPPM.
6. **Proofs (3 new, 39 total).** The headline: **SPPM converges to the same image
   as the path tracer** on the diffuse Cornell box (global brightness + top/bottom
   spatial ratio) — a stringent, independent check of the photon-power
   normalisation and the radius/flux update, since SPPM shares no transport-loop
   code with PT. Plus: SPPM resolves a finite, focused caustic (the floor under a
   glass lens is brighter than the unfocused floor); and the photon-gather grid
   returns *exactly* the in-radius points vs brute force over 2000 random probes.
   Verified in Node: 39/39 self-tests, and a Caustic-Pool SPPM smoke render
   (7210 tris, all finite, bright caustic filaments). `pnpm lint`/`tsc`/`build`
   green via the CI gate.

## Roadmap — 2026-06-16 Lumen 6.0: Metropolis light transport (PSSMLT) (claude)

Lumen 5.0 added a *second* way to grow paths (BDPT). 6.0 adds a fundamentally
different *kind* of estimator. PT and BDPT are both **independent-sample** Monte
Carlo: every sample is drawn from scratch, so when the light that matters is hard
to find (a thin caustic, a room lit only by bounce), almost every sample misses
and the image is noisy. **Markov-chain Monte Carlo** flips this: once the chain
finds an important light path it *stays near it*, exploring the neighbourhood by
mutation, so the hard transport — once discovered — gets sampled densely.

The plan, all shipped this session:

1. **The key reframing.** A path tracer is a deterministic function `F: [0,1)^d →
   radiance`: feed it `d` uniform random numbers and it returns a colour. PSSMLT
   (Kelemen et al. 2002) runs a Metropolis–Hastings chain *over that input
   vector*, with the target density = `I = luminance(F(U))`. So we never touch the
   transport code — we only change *where the random numbers come from*.
2. **`PssmltSampler extends Rng`.** Because the whole engine pulls randomness
   through `Rng.next()`, a sampler subclass that overrides `next()` to return
   coordinates of a mutatable primary-sample-space vector makes every existing
   BSDF/light/phase/spectral routine work *unchanged* under Metropolis. Kelemen's
   lazy mutation (per-coordinate "modify times", large/small steps, wrapped
   Gaussian perturbations, accept/reject backup-restore) keeps the dimension count
   dynamic and the proposal symmetric.
3. **`MltState`.** Owns the splat buffer + the chains. A **bootstrap** of uniform
   samples estimates the image brightness `b = E[I]` (which re-establishes absolute
   scale the chain can't know) and seeds the chains in proportion to contribution
   (no startup bias). Each mutation does **expected-value splatting** (`L/I`
   weighted by the accept probability at both the proposed and current pixels) and
   accepts with `min(1, I′/I)`. `image()` reads back `splat · b·nPixels/mutations`.
4. **Parallel chains.** Each worker runs its own independent chains over the
   *whole* image (not a band) and ships its normalised estimate every pass; the UI
   thread shows the mutation-weighted average of the workers' estimates (each is
   independently unbiased, so the average is too). A single-thread fallback drives
   one `MltState` for the sandboxed thumbnail.
5. **UI.** A third **Integrator** option ("Metropolis"); the sample target now
   reads as mutations-per-pixel; an About card; the footer.
6. **Proofs (3 new, 36 total).** The Metropolis sampler is a valid uniform sampler
   (mean ½, var 1/12) and deterministic; PSSMLT energy-conserves on a white
   furnace; and — the headline — PSSMLT converges to the **same image** as the
   path tracer on the Cornell box, checked on both global brightness *and* the
   top/bottom spatial ratio. Verified in Node: 36/36 self-tests, and a 14-scene
   PSSMLT smoke render (no NaNs; image-mean == b on every scene, incl. spectral,
   volumetric and thin-film). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-15 Lumen 5.0: bidirectional path tracing (claude)

Lumen 4.0 made the *space between* surfaces physical. 5.0 attacks the last and
hardest gap in the *transport algorithm itself*. So far Lumen has been a pure
**unidirectional** path tracer: it only ever grows paths from the camera and
finds light by next-event estimation. That estimator is provably correct but
becomes badly inefficient whenever the light that matters is *hard to reach from
the surfaces you can see* — light bounced off a wall (indirect-only rooms),
emitters tucked inside fixtures, glossy interreflection. **Bidirectional path
tracing (BDPT)** — the Veach–Guibas algorithm — fixes this by also growing a
path *from a light* and then **connecting** every camera-path vertex to every
light-path vertex, weighting all the resulting sampling techniques together with
**multiple importance sampling (balance heuristic)** so the best technique for
each light-transport regime dominates automatically.

The headline is that BDPT has a *built-in correctness oracle*: it is an unbiased
estimator of the **same** rendering equation as the existing path tracer, so the
two must converge to the **same image**. The verification suite exploits this
directly — it renders a box scene with both integrators at high sample counts
and asserts their means agree to within Monte-Carlo error. That is a far
stronger proof than any single invariant.

**Design decision (why it fits the architecture).** The render is a pool of
workers, each owning a *band* of the image and computing every pixel
independently. Full BDPT's `t = 1` "light-tracing" strategy splats a light-path
vertex onto an *arbitrary* pixel, which would need a shared full-frame buffer and
a new worker protocol. Instead Lumen implements **BDPT without light tracing**
(camera-subpath length `t ≥ 2`): every connection contributes to the *current*
pixel, so it drops into the existing band-worker model with **zero protocol
changes**. Marking the camera (lens) vertex as a delta endpoint removes the
`t = 1` technique from the MIS partition as well, keeping every remaining
technique's weights a valid partition of unity — so the estimator stays unbiased
and still matches the path tracer (the only paths lost are those reachable
*solely* by light tracing, e.g. a caustic seen directly, which neither this nor
plain NEE captures well anyway). It also sidesteps the error-prone
camera-importance `Wₑ` math entirely: the camera vertex's own densities provably
never enter the MIS sum for `t ≥ 2`, so the primary ray simply carries weight 1
exactly as the path tracer's does.

Plan / steps:

- [x] `bdpt.ts` — a self-contained bidirectional integrator behind the same
      `(scene, ray, settings, rng, stats, gbuf)` contract as `radiance`:
  - [x] a `Vertex` record (position, geometric + shading normals, throughput β,
        forward/reverse **area-measure** pdfs, delta flag, resolved material),
  - [x] `randomWalk` shared by both subpaths — converts each bounce's directional
        pdf to an area density at the next vertex and back-fills the previous
        vertex's reverse density (the bookkeeping the MIS recurrence needs),
  - [x] a camera subpath (eye vertex marked delta, primary β = 1) and a light
        subpath (emitter point + cosine-emission direction, β = Lₑ·cos/(p·p·p)),
  - [x] the geometry term `G` (both cosines, inverse-square, visibility) and the
        solid-angle→area density conversion,
  - [x] `connect(s,t)` for every strategy: `s=0` (camera path hits an emitter),
        `s=1` (connect to a freshly sampled light point ≡ NEE), and the general
        `s≥2` vertex-to-vertex connection, each through delta vertices correctly
        (skipped, never connected),
  - [x] `misWeight(s,t)` — a faithful port of the pbrt balance-heuristic
        recurrence with the four connection-time reverse-density overrides,
        restored after each connection.
- [x] Triangle-only light sampling for BDPT (`bdptSampleLight`) consistent with
      the light-subpath emitter selection, so `s=0/1/≥2` share one MIS partition;
      the environment is gathered on camera escape (weight 1, unbiased).
- [x] `integrate(...)` dispatcher in `integrator.ts`; `IntegratorSettings.integrator`
      (`'pt' | 'bdpt'`); worker + single-thread fallback both route through it.
- [x] UI — an **Integrator** segmented control (Path Tracer | Bidirectional) in
      the Sampling panel, threaded through `ControlState`, the render key, and
      `setSettings`; an About card explaining BDPT and the oracle.
- [x] New scene — **Cove** (an uplight bouncing off the ceiling; the room is lit
      almost entirely by indirect light — the textbook case where BDPT crushes
      the path tracer's variance), registered in `SCENES`.
- [x] Verification — four new proofs: BDPT white-furnace energy conservation;
      **BDPT mean == path-tracer mean** on a diffuse box (the oracle);
      MIS technique weights sum to 1 over a fixed path; solid-angle→area density
      conversion round-trip.

## Roadmap — 2026-06-15 Lumen 4.0: participating media, thin-film iridescence & QMC (claude)

Lumen 3.0 made the *geometry* and the *sky* physical. 4.0 makes the **space between
surfaces** physical and adds a **wave-optics** material — the two largest gaps left in a
"physically based" renderer that so far only transported light along vacuum segments and
modelled reflection as pure ray optics. Three headline additions, each wired through the
engine, the worker protocol (`SceneDef` is structured-clone-serialised, so every new field
is plain data), the verification suite, the scene registry, and the UI:

1. **Participating media** (`phase.ts`, `MediumDef`, integrator + scene) — bounded
   homogeneous volumes (fog, smoke, clouds, milky jade). The integrator samples a free-flight
   distance from the medium's transmittance; if a collision falls before the next surface the
   path *scatters* inside the volume: it next-event-estimates the lights through the
   **Henyey–Greenstein** phase function (with phase↔light MIS and media-attenuated shadow
   rays, so light shafts and volumetric shadows — "god rays" — emerge), then importance-samples
   a new direction from the same phase function. A scalar extinction with a coloured
   single-scattering albedo keeps the distance estimator unbiased with no spectral MIS, and the
   analytic boundary weights cancel so surfaces seen *through* a volume need no explicit
   transmittance multiply on the camera path. Shadow rays from ordinary surfaces are attenuated
   by the media too, so fog darkens the room, not just the volume.

2. **Thin-film interference** (`thinfilm.ts`, a new `Material` kind) — the iridescent colour of
   soap bubbles, oil on water, anodised titanium and beetle shells, which is *wave optics*, not a
   pigment: two reflections (off the top and bottom of a nm-thin film) interfere, and the path
   difference `δ = 4π n₁ d cosθ₁ / λ` makes the reflectance a function of wavelength. We evaluate
   the exact two-interface **Airy reflectance** per polarisation at the path's committed hero
   wavelength, so the existing spectral machinery turns per-λ reflectance into a full iridescent
   colour for free — a delta-specular coating that fans white light into interference colours the
   way the prism fans it into a rainbow.

3. **Low-discrepancy primary sampling** (`qmc.ts`) — the camera sub-pixel jitter and the lens
   (depth-of-field) disk now come from a **scrambled Halton** sequence with a per-pixel
   **Cranley–Patterson rotation** instead of white-noise `rng.next()`. Low-discrepancy points
   cover the pixel footprint far more evenly, so anti-aliasing and bokeh converge visibly faster
   for the same sample count, while every deeper bounce keeps its decorrelated pseudo-random
   stream (so global illumination is unbiased).

Plan / steps:

- [x] `phase.ts` — Henyey–Greenstein phase value + importance sampler (PBRT `wo`-convention),
      with normalisation, sampler↔pdf and mean-cosine proofs.
- [x] `MediumDef` on `SceneDef`; `Scene` builds the medium list and exposes
      `sampleMediumScatter` (nearest free-flight collision across bounded spheres) and
      `mediaTransmittance` (optical depth along a shadow segment).
- [x] Integrator: medium-scatter branch (albedo throughput, phase NEE + MIS, phase sampling),
      plus media-attenuated surface NEE. Surfaces seen through a volume keep weight 1 (analytic
      cancellation).
- [x] `thinfilm.ts` — two-interface Airy reflectance (s+p averaged); a `thinfilm` `Material`
      resolved to the hero wavelength; delta-specular BSDF; `isDelta`/`resolveMaterial` updated.
- [x] `qmc.ts` — radical-inverse Halton/Sobol + scramble + Cranley–Patterson; camera + worker
      wired to draw the primary 4 dimensions (pixel x/y, lens x/y) from it.
- [x] New scenes — **Cathedral** (god rays through haze), **Iridescence** (a thin-film thickness
      sweep), **Nebula** (a coloured scattering orb beside an iridescent sphere).
- [x] UI — a fog-density control for volumetric scenes; About cards for media, thin-film and QMC.
- [x] Verification — HG normalisation / sampler↔pdf / mean-cosine; homogeneous transmittance =
      e^(−σ_t·L); pure-scattering volume conserves energy (radiance = 1 in a unit field);
      absorbing volume = e^(−σ_t·chord); thin-film R∈[0,1], d→0 collapses to the bare-interface
      Fresnel, and R(blue)≠R(red) (iridescence); Halton L2-discrepancy below random.

## Roadmap — 2026-06-14 Lumen 3.0: meshes, sky & sun NEE (claude)

This pass turns Lumen from a sphere-and-flat-triangle tracer into a real geometry
+ daylight renderer. Each step is wired through the engine, the worker protocol, the
scene registry, the verification suite, and the UI so it is observable and proven:

1. **Smooth shading normals** — the triangle primitive carries optional per-vertex
   normals; `intersectTriangle` returns barycentrics; `Scene.intersect` blends them
   into a shading normal oriented to the geometric hemisphere (the geometric normal
   still drives ray-offsets and front-face). Curved surfaces from flat triangles.
2. **Mesh library** (`mesh.ts`) — indexed generators with exact/area-weighted
   normals (icosphere via recursive subdivision, UV-sphere, torus, surface-of-
   revolution) plus an affine transform (translate/scale/rotate; normals by the
   inverse-transpose) and a triangle-soup emitter into `PrimDef`s.
3. **OBJ importer** (`obj.ts`) — parses `v/vn/f` (triangulates polygon fans),
   recovers area-weighted normals when absent, and fits the mesh to a unit box so
   any pasted model drops straight into a scene.
4. **Preetham sky** (`sky.ts`) — the analytic all-weather daylight model (Perez
   distribution + zenith chromaticity from turbidity & sun elevation), xyY→linear
   RGB, plus a sun disc. A new `sky` environment kind.
5. **Environment light + sun NEE** — any environment with a sun (the daylight
   gradient or the Preetham sky) becomes a *sampled* light: NEE importance-samples
   the sun cone and MIS-weights it against BSDF sampling, and escaped rays are
   MIS-weighted back. Daylight scenes converge dramatically faster; full-sphere
   cone sampling reduces exactly to the white furnace (a new energy proof).
6. **Showcase scenes** — Sky Studio (meshes under the Preetham sky), Revolution
   (lathed goblets + torus), and a paste-your-own Custom OBJ stage.
7. **Verification** — new proofs: smooth-normal interpolation, icosphere normals +
   Euler characteristic, OBJ cube round-trip, torus normal sanity, sky radiance
   positivity/ordering, env-sun sampler↔pdf + cone solid angle, and an
   env-importance-sampled white furnace.
8. **UI / About** — interactive sun (azimuth/elevation/turbidity) for sky scenes,
   an OBJ paste box, and About cards for the new physics.

## Roadmap — 2026-06-14 substantial-improvement pass (claude)

The plan, broken into shippable steps. Each is wired through the engine, the
verification suite, the scene registry, and the UI so it is observable and proven:

1. `texture.ts` — serialisable procedural `Texture` (checker / grid / marble) evaluated
   in world space; diffuse + metal carry an optional `tex`. Resolved per-vertex so the
   BSDF math is untouched. Self-tests for pattern parity and range.
2. `spectrum.ts` — `cauchyIor(base, B, λ)` dispersion + `wavelengthToRGB` with a
   white-point normalisation so a flat spectrum reconstructs to neutral white. Self-tests
   for the white point and that blue refracts more than red.
3. Rough dielectric in `material.ts` — GGX-VNDF microfacet reflect/refract, stochastic
   Fresnel, height-correlated Smith throughput (frosted glass). Energy-bound self-test.
4. Beer–Lambert in `integrator.ts` — track the interior medium, attenuate β by
   exp(−σ·t) across glass; spectral hero-wavelength sampling lazily on the first
   dispersive interaction. Attenuation self-test.
5. `scenes.ts` — Prism (dispersion), Glass Menagerie (roughness + absorption sweeps),
   Textured Studio (checker floor + marble sphere).
6. Per-pixel variance: the renderer keeps Σx², derives a relative-error map, exposes a
   live **noise heatmap** display mode and a convergence read-out, and stops dispatching
   to bands that have converged below an adjustable threshold (adaptive early-out).
7. UI + About + verification copy updated to cover the new physics.

## Session log

- 2026-06-23 (claude/claude-opus-4-8): **Lumen 12.0 — subsurface scattering (light that lives inside
  a surface).** Closed the last gap between Lumen's *transport* and its *materials*: a dielectric can now
  carry an `interior` scattering medium (`Subsurface { sigmaT, albedo, g }`), turning glass into a
  *translucent solid* — marble, jade, wax, skin. The integrator random-walks **inside** the object,
  bounded by the real surface geometry: homogeneous free-flight (distance ∼ e^(−σ_t·t)), a collision
  scatters via the Henyey–Greenstein phase function (β ×= the single-scattering albedo, whose per-channel
  shape *is* the translucency's hue), and reaching the boundary refracts the path out or
  total-internally-reflects it back in through the existing smooth/rough dielectric BSDF. Phase-only
  (no interior NEE) — the surrounding scene's NEE takes over once the path exits, so the estimator stays
  unbiased. Two showcase scenes — **Subsurface Studio** (a back-lit row of marble/jade/honey-wax/rose
  spheres glowing from within) and **Jade Idol** (a hand-turned translucent lathe figurine) — plus
  **five** new proofs: a pure-scattering index-matched furnace returns *exactly* 1 for any phase g
  (zero variance — every path yields 1); a pure-absorbing interior reproduces Beer's law e^(−σ·2r) from
  the free-flight sampler; the **whole** translucent object (real Fresnel boundary + TIR + multiple
  scattering) conserves energy to ≈1; and a per-channel albedo tints the exitance R>G>B (the marble/jade
  mechanism), all bounded ≤1, and the reflectance rises strictly with the interior albedo. Verified in
  Node by bundling the suite with Vite: **66/66** self-tests +
  a render smoke-test of both scenes (finite, fully lit, no leaks through the 1.7k-triangle lathe);
  `pnpm lint`/`tsc`/`build` green via the CI gate. Reuses the volume/phase machinery and changes nothing
  in the transport loop except the new interior walk, so all 61 prior proofs stay green.
- 2026-06-21 (claude/claude-opus-4-8): **Lumen 11.0 — real metals from measured complex IOR.** Replaced
  the Schlick-from-RGB metal Fresnel with measured η(λ)/k(λ) spectra (gold/silver/copper/aluminium/iron/
  chromium) + the exact unpolarised conductor Fresnel, evaluated at the path's committed hero wavelength
  so a metal's hue emerges spectrally (the same machinery that disperses glass). New `conductor.ts`; a
  shared `FresnelSpec` threads complex-IOR through the single-scatter, anisotropic and Kulla–Conty
  multiscatter lobes alike; gated behind an optional `spectrum` field so all 55 prior proofs stay
  bit-for-bit green. New **Metals of the World** scene + an About card + **six** proofs (R∈[0,1] &
  grazing→1; k→0 reduces *exactly* to the dielectric Fresnel; textbook colours; a furnace render
  reconstructing the measured RGB; sampler↔pdf↔weight MIS consistency; spectral multiscatter energy
  bounded by F̄). Verified in Node: **61/61** self-tests + a Metals smoke render (finite, lit,
  chromatic); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 10.0 — a physically based material system.** Made the
  *surfaces* as rigorous as the transport. (1) **Energy-conserving rough metal**: a Kulla–Conty
  multiscatter compensation lobe driven by a start-up-built GGX directional-albedo table `E(μ,α)`/
  `Eavg(α)` (integrated via the white-lobe VNDF throughput `G2/G1`), with a coloured multiscatter
  Fresnel so rough conductors recover their dropped energy and stop going grey. (2) **Anisotropic
  GGX** (brushed metal): anisotropic D / Smith Λ / VNDF with two roughness axes in a rotatable
  tangent frame; the isotropic case reduces exactly to the old lobe so existing metals are untouched.
  (3) **Oren–Nayar** rough diffuse (`sigma`) for chalk/clay/plaster. (4) **Clear-coat** layered
  materials (`coat`): a GGX dielectric gloss over a Lambert/Oren–Nayar base, both lobes Fresnel-
  sampled with a combined pdf so the stack is energy-conserving *and* MIS-consistent. All four ride
  as optional fields on the existing `diffuse`/`metal` kinds (no new union members → the integrators,
  BDPT and SPPM are untouched), and shared local-frame helpers keep `sample`/`eval`/`pdf` in lockstep.
  Three new scenes — **Brushed Metal**, **Rough Conductors** (single-scatter vs multiscatter split),
  **Ceramics & Clay** — and **six** new proofs plus a **BDPT≡PT oracle** over a box of all four
  materials (PT and BDPT agree to 0.4%). Verified in Node (55/55 self-tests + a 3-scene render smoke
  test, no NaNs, all lit); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 9.1 — emissive volumes (glowing fire / embers /
  nebulae).** Built straight on the 9.0 heterogeneous-media engine: a medium may now carry an
  `emission` radiance, and at every *real* collision the path collects `(σ_a/σ_t)·Lₑ =
  (1−albedo)·Lₑ` of self-emitted light, weighted by the throughput *before* the scattering albedo
  is applied. Because delta tracking makes real collisions density-proportional, the glow pools in
  the dense core of an fBm field and fades through the wisps — a soft, physically integrated
  fireball, no billboards. One surgical add in the integrator's medium-scatter branch; the
  homogeneous and non-emissive paths are untouched. New **Ember** scene (a warm self-luminous
  fBm fireball over a dim floor in a dark room) and **one new proof (49 total):** an
  absorbing+emitting volume against black obeys the emission–absorption law `(1−e^(−σ_t·chord))·Lₑ`
  exactly (measured 1.5983 vs 1.5962). Verified in Node (49/49 self-tests + an Ember smoke render:
  finite, glowing core max 3.2, self-shadowing); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 9.0 — heterogeneous participating media (clouds,
  smoke & layered fog) via delta & ratio tracking.** Turned the 4.0 *homogeneous* volumes (a sphere
  of constant fog) into real **heterogeneous** media whose extinction varies continuously through
  space. (1) **`noise.ts`** — a dependency-free 3D value-noise + fBm + domain-warp toolkit (hashed
  integer lattice, quintic-smoothstep interpolation), pure and allocation-free so the field
  evaluates identically on every worker. (2) **`MediumDef.density`** — an optional, structured-clone
  `DensityDef` union: `fbm` (cumulus/smoke — octaves, frequency, coverage threshold, soft spherical
  edge falloff, vertical bias, domain warp) and `layer` (an exponential vertical fog slab). Absent ⇒
  the 4.0 homogeneous behaviour, bit-for-bit. (3) **`volume.ts`** — compiles a `DensityDef` into a
  `DensityField` (`majorant` + `density(p)∈[0,1]`) bounded by the medium sphere. (4) **Scene** —
  `sampleMediumScatter` now **delta-tracks** heterogeneous media (Woodcock: analytic flights against
  the constant majorant σ̄=sigmaT, accept a *real* scatter with probability σ(x)/σ̄=density(x), else a
  *null* collision and continue) and `mediaTransmittance(…, rng)` **ratio-tracks** them
  (T̂=∏(1−σ(xᵢ)/σ̄), an unbiased estimator of e^(−∫σ ds) needing no closed form); the homogeneous path
  stays analytic. (5) **Integrator** — the only change is threading `rng` into the two
  `mediaTransmittance` calls (the collision branch already multiplies β by the albedo, the correct
  delta-tracking real-collision weight, and the camera path still needs no transmittance multiply
  because null collisions leave β unchanged). (6) **Three scenes** — **Cumulus** (a sunlit fBm cloud
  under the Preetham sky with a forward-scattering silver lining), **Smoke Plume** (a rising,
  vertically-biased, sooty column lit hard from the side — deep self-shadowed darks), **Drifting
  Fog** (an exponential ground-fog layer in a colonnade so the skylight breaks into god-rays grazing
  the fog top). (7) **UI** — the fog-density knob already scales the majorant; added a **Cloud
  coverage** control (offsets the fBm threshold to puff the cloud up or break it into scattered
  billows) and an About card on delta/ratio tracking. (8) **Five new proofs (48 total):** the noise
  field is bounded/continuous/deterministic/mean-½; delta tracking with a constant field reproduces
  e^(−σL) (reach 0.2474 vs 0.2466); ratio tracking on a varying exponential layer matches a fine
  quadrature of ∫σ ds (T̂=0.1657 vs e^(−τ)=0.1653, τ=1.80); delta tracking matches the same varying
  optical depth (reach 0.1663 vs 0.1653); and a heterogeneous pure-scattering fBm volume in a unit
  field conserves energy *exactly* (radiance through cloud = 1.0000) — the end-to-end oracle for the
  whole delta-tracking integrator. Verified in Node by bundling the engine with esbuild: 48/48
  self-tests, plus a smoke render of all three new scenes (all-finite, energetic, self-shadowing).
  `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-19 (claude/claude-opus-4-8): **Lumen 8.0 — a spectral, daylight-complete photon mapper.**
  Closed the two deliberate gaps in the 7.0 photon mapper. **(1) Spectral photons:** a photon now
  commits a random hero wavelength the first time it strikes a dispersive surface (reusing the path
  tracer's `isSpectral`/`wavelengthWeight`/`resolveMaterial(.,.,λ)` machinery verbatim), so it refracts
  per-colour and the caustic it deposits is a *rainbow* instead of white — and because the per-λ RGB
  weights average to (1,1,1), total energy is exactly preserved. The camera pass commits a wavelength
  symmetrically so a prism viewed directly disperses too. **(2) Environment/sun photons:** the scene's
  sun (a gradient sun or a Preetham sky, already an NEE light) is now also a photon source — photons
  leave a disc sized to the scene's bounding sphere, perpendicular to the sun, and rain in as a
  parallel beam, so daylight scenes finally get photon-mapped sun caustics and indirect light. The
  distant-light flux works out to `S = L·ΣW/lum(L_rep)`, the literal twin of the area-light formula
  (the disc-area πR² and cone solid-angle Ω cancel against the selection weight), so it's unbiased and
  needs no other code changes. **(3) Two scenes:** **Spectral Caustic** (a dispersive sphere + prism
  over a white floor → a rainbow caustic) and **Daylight Lens** (a glass sphere + gold torus under the
  sky → a sun caustic on a tiled floor). **(4) Four new proofs (43 total):** spectral photons conserve
  energy vs the achromatic twin (rel 0.22%); the spectral caustic carries real chromatic spread (0.69)
  while the achromatic one is exactly grey (0.00); env-sun photons match the path tracer on a sun-lit
  courtyard (rel 2.53%, pinning the distant-light flux normalisation); and the sun focuses a real
  caustic through glass (≈8.7× the lit floor). Verified in Node by bundling the engine with Vite:
  43/43 self-tests, plus a smoke render of both new scenes (all-finite, energetic, hundreds of
  chromatic caustic pixels). `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-16 (claude/claude-opus-4-8): **Lumen 7.0 — stochastic progressive photon mapping (SPPM).**
  Added a *fourth* light-transport integrator, the one built for **caustics** — light focused through
  glass onto a diffuse surface (a light→specular→diffuse path), which all three existing integrators
  sample terribly because next-event estimation can't connect through the refractive interface. SPPM
  runs the transport *backwards*: (1) `sppm.ts` emits photons from the area lights (power-sampled, so
  every photon carries equal flux), traces them through the specular geometry reusing the existing
  `Scene`/BSDF/medium code verbatim, and deposits them at non-specular surfaces; (2) each pass
  re-traces *jittered* camera rays (the "stochastic" in SPPM — anti-aliases + handles glossy/DoF
  visible points), follows specular bounces, and stores the first diffuse hit as a per-pixel
  measurement point; (3) the photons are gathered through an exact CSR **spatial hash** (`HashGrid`)
  and each point's gather radius is shrunk on the Hachisuka schedule `R²←R²·(N+αM)/(N+M)`, which
  drives the density-estimation bias to zero so the estimate **converges**. (4) SPPM is a full-frame
  estimator like PSSMLT, so the worker + renderer were generalised behind a small `FrameEstimator`
  interface (each worker runs an independent full-frame SPPM; the UI averages them by passes). (5) A
  fourth **Integrator** option ("Photon Map"), a "Passes" progress readout, an About card, the
  footer. (6) A new **Caustic Pool** scene — a sine-ripple water surface (a single refractive sheet
  with *analytic* smooth normals) over a tiled floor — that throws the shifting bright filaments of a
  swimming pool. (7) **Three new proofs (39 total):** the headline is **SPPM ≡ the path tracer** on
  the diffuse Cornell box (global brightness *and* top/bottom spatial ratio agree to ~2.6% — a strict
  check since SPPM shares no transport-loop code with PT, so this pins the photon-power
  normalisation and the radius/flux update); plus SPPM resolves a finite, focused caustic under a
  glass lens; and the photon-gather grid returns *exactly* the in-radius points vs brute force over
  2000 random probes. Verified in Node by bundling the engine with Vite: 39/39 self-tests, plus a
  Caustic-Pool SPPM smoke render (7210 tris, all-finite, bright caustic filaments). `pnpm
  lint`/`tsc`/`build` green via the CI gate.
- 2026-06-16 (claude/claude-opus-4-8): **Lumen 6.0 — Metropolis light transport (PSSMLT).** Added a
  *third* light-transport integrator, and a fundamentally different one: where the path tracer and
  BDPT average independent samples, PSSMLT runs a **Markov chain** through path space so it lingers
  wherever light is and refines the hardest-to-find transport (caustics, indirect-only rooms) far
  faster. The whole thing reuses the path tracer **verbatim** — a path tracer is a function from a
  vector of uniform randoms to a colour, so the new `PssmltSampler` simply *is* the RNG (`extends
  Rng`, overriding `next()` to return coordinates of a mutatable primary-sample-space vector with
  Kelemen lazy mutation: per-coordinate modify-times, large/small steps, wrapped-Gaussian
  perturbations, accept/reject backup-restore). `MltState` owns the chains and the splat buffer: a
  **bootstrap** estimates the absolute image brightness `b = E[I]` and seeds chains in proportion to
  contribution; each mutation does **expected-value splatting** (`L/I` weighted by the
  Metropolis–Hastings accept probability `min(1,I′/I)`) at both endpoints; `image()` renormalises by
  `b·nPixels/mutations`. It runs across the **worker pool** (each worker = independent chains over
  the whole image; the UI shows their mutation-weighted average, each estimate independently
  unbiased) with a single-thread fallback for the sandboxed thumbnail. UI: a "Metropolis" integrator
  option, a mutations-per-pixel read-out, an About card, the footer. **Three new correctness proofs
  (36 total):** the sampler is a valid uniform sampler (mean ½, var 1/12) + deterministic; PSSMLT
  energy-conserves on a white furnace (rel 0.04%); and PSSMLT converges to the **same image** as the
  path tracer on the Cornell box (global brightness rel 0.7% *and* top/bottom spatial ratio rel
  0.4%). Verified in Node (36/36 self-tests + a 14-scene PSSMLT smoke render: no NaNs, image-mean ==
  b on every scene incl. spectral/volumetric/thin-film); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-15 (claude/claude-opus-4-8): **Lumen 5.0 — bidirectional path tracing.** Added a second,
  selectable light-transport integrator alongside the unidirectional path tracer: a full
  **Veach–Guibas BDPT** (`bdpt.ts`). It grows a camera subpath and a light subpath, then forms every
  connection strategy — `s=0` (camera path hits an emitter), `s=1` (≡ next-event estimation) and the
  general `s≥2` vertex-to-vertex connection — and weights them all with a faithful port of pbrt's
  **balance-heuristic MIS recurrence** (per-vertex area-measure forward/reverse densities, the four
  connection-time reverse-density overrides, delta vertices transported but never connected). It is
  "BDPT without light tracing" (camera-subpath length `t≥2`): every connection lands in the current
  pixel, so it dropped into the band-worker render loop with **zero protocol changes**, and marking
  the lens vertex as a delta endpoint removes the `t=1` technique from the MIS partition (still a
  valid partition of unity, still unbiased, still matching the path tracer — and it sidesteps the
  camera-importance `Wₑ` math, which provably never enters the weight for `t≥2`). While wiring it up
  I also fixed a latent inconsistency in the unidirectional integrator: BSDF-hit **emission is now
  one-sided** (winding-front only), matching what the NEE light sampler already required, so the two
  estimators agree term for term. New **Cove** scene — an emitter hidden in an uplight cove so the
  room is lit almost entirely by bounced light, the textbook regime where BDPT crushes the path
  tracer's variance (measured ≈3× lower per-sample variance at equal settings). UI: an **Integrator**
  segmented control (Path Tracer | Bidirectional) + an About card. **Four new correctness proofs
  (33 total):** BDPT white-furnace energy (ρ recovered to 0.8000); the **oracle** — BDPT's mean image
  equals the path tracer's on a diffuse box (1.0% at 280 spp, shrinking as 1/√n); **MIS weights
  partition to 1** on a fixed path (residual = 0, exactly); and the solid-angle→area density
  conversion. Verified end to end in Node by bundling the engine with rolldown — all 33 self-tests
  pass and BDPT↔PT agree to <0.5% at 3000 spp on both the diffuse box and the full Cornell box (with
  mirror + glass), no NaNs; `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-14 (claude): Built Lumen end to end — full CPU path tracer (BVH, microfacet BSDFs,
  NEE+MIS, RR), worker pool with single-thread fallback, denoiser, tone mapping, 4 scenes, orbit
  camera/DoF, verification suite, and the React studio UI. Lints + builds clean via the CI gate.
- 2026-06-14 (claude): Substantial physics pass. Added (1) procedural world-space textures
  (`texture.ts`: checker / grid / value-noise marble), (2) rough microfacet dielectrics for frosted
  glass (GGX-VNDF reflect/refract), (3) Beer–Lambert volumetric absorption for physically coloured
  glass (medium tracking in the integrator), (4) spectral dispersion (`spectrum.ts`: Cauchy IOR +
  white-point-normalised wavelength→RGB, hero-wavelength sampling) producing prism rainbows, and
  (5) adaptive variance-guided sampling with a live per-pixel noise (relative-error) heatmap and a
  convergence read-out. Three new scenes (Prism, Glass Menagerie, Textured Studio) and six new
  correctness proofs (16 total) — all pass. Verified numerically in Node by bundling the engine with
  rolldown and running the self-tests + a 7-scene render smoke test (no NaNs); `pnpm lint`/`build`
  green via the CI gate.
- 2026-06-14 (claude/claude-opus-4-8): **Lumen 3.0 — meshes, sky & sun NEE.** Turned the
  sphere-and-flat-triangle tracer into a real geometry + daylight renderer. Added (1) **smooth
  triangle meshes**: the triangle primitive now carries per-vertex normals, `intersectTriangle`
  returns barycentrics, and `Scene.intersect` blends them into a shading normal oriented to the
  geometric hemisphere (geometric normal still drives offsets/front-face). (2) A **mesh library**
  (`mesh.ts`) — icosphere (recursive subdivision), uv-sphere, torus and surface-of-revolution with
  exact/area-weighted normals, an affine transform with inverse-transpose normal handling, and a
  smooth-tri emitter. (3) An **OBJ importer** (`obj.ts`) — v/vn/f with polygon-fan triangulation,
  area-weighted normal recovery, and auto-fit to a unit box. (4) The **Preetham analytic sky**
  (`sky.ts`) — Perez distribution + zenith chromaticity from turbidity & sun elevation, xyY→linear
  RGB, plus a solar disc; a new `sky` env. (5) **Environment / sun next-event estimation** — any
  env with a sun (the daylight gradient or the sky) is now a *sampled* light: NEE importance-samples
  the sun cone and MIS-weights it against BSDF sampling, with escaped rays MIS-weighted back, so
  daylight scenes converge in a handful of spp. (6) Three scenes — **Sky Studio**, **Revolution**
  (lathed goblets), **Custom OBJ** (paste your own). (7) **Fixed a latent BVH robustness bug**:
  axis-aligned planar faces (floor/wall quads, coplanar facets) had zero-thickness AABBs that the
  slab test rejected, so such a face only rendered when its BVH leaf happened to also hold a
  non-coplanar primitive — now degenerate-thin bounds are padded. (8) Seven new correctness proofs
  (23 total): smooth-normal interpolation, icosphere radial normals + Euler χ=2, OBJ cube
  round-trip, torus normals, Preetham positivity/ordering, env-sun sampler↔pdf + cone solid angle,
  and an env-importance-sampled white furnace (ρ recovered exactly). (9) UI: interactive sun
  (azimuth/elevation/turbidity) for sky scenes, an OBJ paste box, and new About cards. Verified
  numerically in Node by bundling the engine with Vite and running all 23 self-tests (23/23) + a
  10-scene render smoke test (no NaNs, all lit); `pnpm lint`/`build` green via the CI gate.
- 2026-06-15 (claude/claude-opus-4-8): **Lumen 4.0 — participating media, thin-film iridescence
  & quasi-Monte-Carlo sampling.** Made the *space between surfaces* and a *wave-optics* material
  physical. (1) **Participating media** (`phase.ts`, `MediumDef`, scene + integrator): bounded
  homogeneous volumes (fog/smoke/cloud). The integrator samples a free-flight distance from the
  medium's transmittance; a collision before the next surface makes the path scatter *inside* the
  volume — in-scattering NEE through the **Henyey–Greenstein** phase function (phase↔light MIS, with
  shadow rays attenuated by `mediaTransmittance` so volumetric shadows/god-rays form), then a
  phase-importance-sampled new direction. A scalar extinction with a coloured single-scattering
  albedo keeps the distance estimator unbiased (no spectral MIS) and the analytic boundary weights
  cancel, so surfaces *seen through* a volume need no transmittance multiply on the camera path.
  Surface NEE is media-attenuated too. (2) **Thin-film interference** (`thinfilm.ts`, a `thinfilm`
  `Material`): the iridescence of soap bubbles / oil / anodised metal as exact two-interface **Airy
  reflectance** (s+p averaged) at the path's committed hero wavelength — a delta-specular coating
  whose reflectance is wavelength-dependent, so the existing dispersion machinery turns it into a
  full iridescent colour (`isSpectral` now drives the wavelength commit for both dispersive glass
  and films). (3) **Low-discrepancy primary sampling** (`qmc.ts`): the camera sub-pixel jitter and
  the depth-of-field lens are now drawn from a **scrambled Halton** sequence with a per-pixel
  Cranley–Patterson rotation (deeper bounces keep their RNG stream), so AA and bokeh converge
  faster. Three new scenes — **Cathedral** (banded god-rays through forward-scattering haze),
  **Iridescence** (a thin-film thickness sweep — soap-bubble to beetle-shell colour), **Nebula** (a
  coloured single-scattering orb beside an iridescent sphere). UI: a live fog-density control for
  volumetric scenes + three new About cards. **Six new correctness proofs (29 total):** HG phase
  normalisation/sampler↔pdf/mean-cosine (E[cosθ]=−g), homogeneous transmittance = e^(−σ_t·L), a
  pure-scattering volume conserving energy (radiance = 1 in a unit field), an absorbing volume =
  e^(−σ_t·chord), thin-film R∈[0,1] with the d→0 limit collapsing to the bare-interface Fresnel
  (err 5.6e-17) and R(λ) iridescent, and Halton L2 star-discrepancy 4× below random. Verified in
  Node (29/29 self-tests + a 13-scene render smoke test: no NaNs, all lit); `pnpm lint`/`tsc`/`build`
  green via the CI gate.
