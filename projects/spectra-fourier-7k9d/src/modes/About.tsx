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
        <h3>The nine modes</h3>
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
          <li>
            <strong>Vocoder</strong> — the FFT put to work: a <em>phase vocoder</em> time-stretches
            and pitch-shifts sound <strong>independently</strong>. It recovers each bin's true
            frequency from how its phase turns between frames, then re-integrates it at a new hop.
            Stretch a note without lowering it; raise it without slowing it down.
          </li>
          <li>
            <strong>Compress</strong> — JPEG is a Fourier transform in disguise. Take the discrete
            cosine transform of each 8×8 block, quantise away the coefficients the eye won't miss,
            and invert. Drop the quality to watch ringing and blocking appear, with honest PSNR and
            compression-ratio numbers.
          </li>
          <li>
            <strong>Cepstrum</strong> — the "spectrum of the log-spectrum." It separates a voiced
            sound's <em>pitch</em> (a sharp peak in quefrency) from its <em>formants</em> (a smooth
            envelope), and detects the pitch two independent ways — cepstral peak and
            autocorrelation.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>The transform as an engine</h3>
        <div className="formula">ω̂ₖ = ωₖ + princarg(Δφ − ωₖ·Hₐ) / Hₐ</div>
        <p>
          The last three modes stop <em>showing</em> the transform and start <em>using</em> it. The{' '}
          <strong>phase vocoder</strong> reads a bin's true frequency ω̂ₖ from the phase it accrued
          between two analysis hops (above), then re-integrates that frequency at a rescaled
          synthesis hop — decoupling time from pitch. The <strong>compression</strong> lab swaps the
          DFT for its even-symmetric cousin, the <strong>DCT-II</strong>, whose energy compaction is
          why JPEG, MP3 and every video codec are built on it:
        </p>
        <div className="formula">X[k] = √(2/N)·c(k)·Σₙ x[n]·cos( π(2n+1)k / 2N )</div>
        <p>
          And the <strong>cepstrum</strong> exploits a single algebraic fact — a log turns the
          product of a source spectrum and a filter spectrum into a <em>sum</em> — so a second
          Fourier transform separates them by rate: <code>c[q] = IFFT(log|FFT(x)|)</code>.
        </p>
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
          condition that makes it a valid wavelet. The new engines are guarded too: the phase
          vocoder's identity round-trip reconstructs to over 40&nbsp;dB SNR and its window is
          confirmed constant-overlap-add; an octave pitch-shift is checked to double the detected
          pitch; the DCT round-trips and preserves energy (orthonormality), its 8×8 codec's
          rate/distortion curve is monotone, and the cepstral peak lands on the true period of a
          harmonic signal. Open the console to see all fifteen pass.
        </p>
        <p className="pill">Built with React + TypeScript + Canvas 2D + Web Audio</p>
      </div>
    </div>
  )
}
