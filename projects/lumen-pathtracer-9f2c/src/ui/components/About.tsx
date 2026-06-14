// About.tsx — a written tour of how the renderer works, for curious visitors.

import type { ReactNode } from 'react'

export function About() {
  return (
    <div className="about">
      <h2>How Lumen works</h2>
      <p className="lead">
        Lumen is a physically based <strong>Monte-Carlo path tracer</strong> written from scratch in
        TypeScript — no WebGL, no GPU, no third-party math. It numerically solves the rendering
        equation by tracing thousands of random light paths per pixel and averaging their
        contributions, converging to a photorealistic image.
      </p>

      <div className="about-grid">
        <Card title="The rendering equation">
          Every pixel estimates{' '}
          <code>L₀ = Lₑ + ∫ f(ωᵢ,ω₀)·Lᵢ(ωᵢ)·cosθ dωᵢ</code> by Monte-Carlo integration. Paths start
          at the camera and random-walk through the scene, accumulating throughput until they reach a
          light or escape to the environment.
        </Card>
        <Card title="Multiple importance sampling">
          At each surface two estimators compete: sampling a light directly (great for small bright
          lights) and sampling the BSDF lobe (great for glossy surfaces and broad skies). The{' '}
          <em>power heuristic</em> blends them, so neither one’s variance dominates.
        </Card>
        <Card title="Microfacet BSDFs">
          Surfaces are Lambertian diffuse, GGX/Trowbridge-Reitz metal with height-correlated Smith
          shadowing, or smooth dielectric glass with exact Fresnel. Rough reflections use{' '}
          <em>visible-normal (VNDF)</em> sampling for low variance.
        </Card>
        <Card title="SAH bounding volume hierarchy">
          A binned <em>surface-area-heuristic</em> BVH turns the brute-force O(n) ray/scene test into
          an expected O(log n) traversal, which is what makes thousands of triangles tractable on a
          CPU at interactive rates.
        </Card>
        <Card title="A worker pool">
          The image is split into horizontal bands, one per CPU core. Each Web Worker builds its own
          BVH and renders one sample per pass, streaming results back as transferable buffers that the
          main thread accumulates. Sandboxed contexts fall back to a chunked single-thread loop.
        </Card>
        <Card title="Progressive accumulation & denoise">
          Samples accumulate into an HDR buffer that is ACES tone-mapped every frame. An edge-avoiding
          À-Trous wavelet filter, guided by an albedo/normal G-buffer, can clean the remaining noise
          for a crisp still — without touching the underlying samples.
        </Card>
      </div>

      <p className="about-foot">
        Drag the viewport to orbit · scroll to dolly · raise the sample target for a cleaner image ·
        open <strong>Verify</strong> to run the engine’s correctness proofs.
      </p>
    </div>
  )
}

function Card(props: { title: string; children: ReactNode }) {
  return (
    <div className="about-card">
      <h3>{props.title}</h3>
      <p>{props.children}</p>
    </div>
  )
}
