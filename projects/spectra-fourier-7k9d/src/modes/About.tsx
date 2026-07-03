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
        <h3>The six modes</h3>
        <ul>
          <li>
            <strong>Epicycles</strong> — treat a drawn curve's points as complex numbers, FFT
            them, and each coefficient becomes a rotating vector. Chained largest-first, the
            vectors redraw the shape. It's the Fourier series made visible.
          </li>
          <li>
            <strong>Spectrum</strong> — build a waveform and read its magnitude and phase spectra.
            A square wave shows only odd harmonics; a window function tames the spectral leakage
            that appears when a frequency doesn't fit a whole number of cycles. Hit{' '}
            <em>Play</em> to <strong>hear</strong> the timbre you're building.
          </li>
          <li>
            <strong>Filter</strong> — filtering is just multiplication in the frequency domain.
            Multiply each bin by a response curve, invert, and the noise or unwanted tones are
            gone. Play the input and the filtered output back-to-back to hear the difference.
          </li>
          <li>
            <strong>Spectrogram</strong> — a short-time Fourier transform slides a fixed window
            across the signal, producing a time × frequency heatmap. It exposes the time/frequency
            trade-off at the heart of signal processing.
          </li>
          <li>
            <strong>Wavelet</strong> — the continuous wavelet transform dilates a little wave (the
            Morlet) to fit each frequency: short and sharp up high, long and selective down low.
            Its adaptive resolution is shown side-by-side with the fixed-window STFT.
          </li>
          <li>
            <strong>Image (2-D)</strong> — the transform is separable, so an image FFT is just
            "rows then columns." Paint a mask over the 2-D frequency plane — keep the center to
            blur, keep the rim to find edges — and invert to rebuild the filtered picture.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>Beyond one dimension</h3>
        <div className="formula">X[k,l] = Σₘ Σₙ x[m,n] · e^(−2πi(km/M + ln/N))</div>
        <p>
          The 2-D transform above factors into two 1-D transforms — transform every row, then every
          column — which is exactly how the <strong>Image</strong> mode reuses the same radix-2
          FFT. The <strong>Wavelet</strong> mode leans on the convolution theorem instead:
          convolving a signal with each scaled Morlet wavelet is a multiply in the frequency
          domain, so one forward FFT plus one inverse per scale builds the whole scalogram.
        </p>
      </div>

      <div className="card">
        <h3>Why it's honest</h3>
        <p>
          Everything you see is computed live from the same core — there is still no math library
          anywhere. On startup the app runs a suite of <strong>self-tests</strong> in development:
          the 1-D FFT is checked against a direct DFT, round-trips through its inverse, and is
          confirmed linear; the <strong>2-D FFT</strong> round-trips and matches a separable
          reference; <strong>Parseval's theorem</strong> (energy is conserved between domains) is
          verified; and the Morlet wavelet is confirmed to have (near) zero mean, the admissibility
          condition that makes it a valid wavelet. Open the console to see them pass.
        </p>
        <p className="pill">Built with React + TypeScript + Canvas 2D + Web Audio</p>
      </div>
    </div>
  )
}
