// About — what the app is and the color science behind it.

export function About() {
  return (
    <div className="about-page">
      <section className="card prose">
        <h2>Gradient Lab</h2>
        <p>
          A perceptual color &amp; gradient studio. Everything here — every color-space conversion,
          the gradient sampler, the mesh renderer, palette clustering, contrast and color-vision
          math — is written from scratch in TypeScript, with <b>no color libraries</b>.
        </p>

        <h3>Why interpolation space matters</h3>
        <p>
          Plain CSS blends gradients in <b>sRGB</b>, the gamma-encoded space your screen stores. The
          midpoint of a blue→yellow ramp drifts through a dead grey, because the numeric average of
          two encoded colors isn&rsquo;t the perceptual average. Blend instead in <b>Oklab</b> or
          <b>Oklch</b> — perceptually uniform spaces — and the ramp keeps its luminance and never
          muddies. The comparison strip in the studio shows all seven spaces on the same stops at
          once.
        </p>

        <h3>The pipeline</h3>
        <p>
          Colors travel sRGB → linear light → CIE&nbsp;XYZ (D65), and from there into CIELab/LCh or,
          via the LMS cone response, into Oklab/Oklch (Björn Ottosson&rsquo;s construction). Each
          conversion has an exact inverse, so a color round-trips through any space without drift —
          verified by the <b>Tests</b> page.
        </p>

        <h3>Gamut: color you can name vs. color you can show</h3>
        <p>
          Oklch lets you ask for colors more vivid than any sRGB screen can actually display — they
          fall outside the <b>gamut</b>. The <b>Gamut</b> page draws the sRGB boundary as a slice
          through Oklch (lightness × chroma at a fixed hue) so you can see exactly where a color
          runs out of room. When perceptual interpolation strays past that boundary you can either
          <b> clip</b> each RGB channel (fast, but it shifts hue) or <b>map</b> the chroma down the
          way the CSS&nbsp;Color&nbsp;4 spec prescribes: shrink saturation in Oklch until the clipped
          result is within a just-noticeable <b>ΔE-OK</b>, preserving hue and lightness.
        </p>

        <h3>How different are two colors?</h3>
        <p>
          The Gamut page also measures the perceptual distance between adjacent stops with four
          metrics, from the naïve Euclidean <b>ΔE₇₆</b> through <b>CIE94</b> to <b>CIEDE2000</b> — the
          modern standard, with its hue-rotation and blue-region interaction term. Our CIEDE2000 is
          verified on the <b>Tests</b> page against the canonical Sharma–Wu–Dalal (2005) reference
          data set (34 pairs, to 1e-4). The same metric powers the &ldquo;nearest CSS name&rdquo;
          lookup.
        </p>

        <h3>What you can do</h3>
        <ul>
          <li><b>Studio</b> — multi-stop linear / radial / conic gradients, interpolated in any of seven spaces, four hue-walk modes, with per-segment <b>easing</b> (real cubic-bézier curves) and a clip/map gamut switch.</li>
          <li><b>Gamut</b> — the Oklch gamut-boundary visualizer, clip-vs-map comparison, ΔE matrix (76/94/2000/OK), and nearest-name lookup.</li>
          <li><b>Animate</b> — hue-cycle, sweep, or conic-spin your gradient with a live preview and copy-paste <code>@keyframes</code> CSS.</li>
          <li><b>Mesh</b> — drag colored control points; the field is an inverse-distance blend computed in Oklab.</li>
          <li><b>Palette</b> — Oklch harmonies, or extract a palette from any image with k-means in Oklab.</li>
          <li><b>Export</b> — copy CSS / <code>oklch()</code> CSS / SVG / JSON, download a dithered PNG, or share the whole design as a URL.</li>
          <li><b>Accessibility</b> — WCAG&nbsp;2.1 + APCA contrast between stops, and a protan / deutan / tritan color-vision preview.</li>
        </ul>

        <p className="muted small">
          Built autonomously as part of the{' '}
          <a href="https://kkd16.github.io/agent-experiments/" target="_blank" rel="noreferrer">
            Agent App Factory
          </a>
          .
        </p>
      </section>
    </div>
  )
}
