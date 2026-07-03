export default function About() {
  return (
    <div className="about">
      <div className="card">
        <h2>What is a Fourier transform?</h2>
        <p>
          Any signal — a sound, a wiggle, even the outline of a drawing — can be rebuilt as a sum
          of pure sinusoids. The <strong>Fourier transform</strong> is the machine that finds the
          recipe: for every frequency, how much of it is present and at what phase. Spectra is a
          hands-on lab for that idea, built on a from-scratch{' '}
          <span className="pill">FFT · no math libraries</span>.
        </p>
        <div className="formula">X[k] = Σₙ x[n] · e^(−2πi·kn/N)</div>
        <p>
          The forward transform above turns <code>N</code> samples into <code>N</code> complex
          coefficients. The inverse flips the sign in the exponent and divides by <code>N</code>,
          rebuilding the signal exactly. The <em>Fast</em> Fourier Transform computes this in{' '}
          <code>O(N log N)</code> instead of <code>O(N²)</code> by recursively splitting the sum
          into even and odd samples (Cooley–Tukey). Here it runs iteratively, in place, on typed
          arrays.
        </p>
      </div>

      <div className="card">
        <h3>The four modes</h3>
        <ul>
          <li>
            <strong>Epicycles</strong> — treat a drawn curve's points as complex numbers, FFT
            them, and each coefficient becomes a rotating vector. Chained largest-first, the
            vectors redraw the shape. It's the Fourier series made visible.
          </li>
          <li>
            <strong>Spectrum</strong> — build a waveform and read its magnitude and phase spectra.
            A square wave shows only odd harmonics; a window function tames the spectral leakage
            that appears when a frequency doesn't fit a whole number of cycles.
          </li>
          <li>
            <strong>Filter</strong> — filtering is just multiplication in the frequency domain.
            Multiply each bin by a response curve, invert, and the noise or unwanted tones are
            gone. Low-, high-, band-pass and notch are all one masking step.
          </li>
          <li>
            <strong>Spectrogram</strong> — a short-time Fourier transform slides a window across
            the signal, producing a time × frequency heatmap. It exposes the time/frequency
            trade-off at the heart of signal processing.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>Why it's honest</h3>
        <p>
          Everything you see is computed live from the same core. On startup the app runs a small
          suite of <strong>self-tests</strong> in development: the FFT is checked against a direct
          DFT, verified to round-trip through the inverse, and confirmed to be linear and to place
          a cosine's energy in exactly two bins. Open the console to see them pass.
        </p>
        <p className="pill">Built with React + TypeScript + Canvas 2D</p>
      </div>
    </div>
  )
}
