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

        <h3>What you can do</h3>
        <ul>
          <li><b>Studio</b> — multi-stop linear / radial / conic gradients, interpolated in any of seven spaces with four hue-walk modes.</li>
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
