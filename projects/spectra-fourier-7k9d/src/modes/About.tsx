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
        <h3>The thirteen modes</h3>
        <ul>
          <li>
            <strong>Epicycles</strong> — treat a curve's points as complex numbers, FFT them, and
            each coefficient becomes a rotating vector. Chained largest-first, the vectors redraw
            the shape. Draw your own scribble, or point it at an <strong>image</strong>: a
            Moore-neighbour tracer pulls the outline of a glyph or uploaded silhouette out of the
            picture and the epicycles redraw it. The Fourier series made visible.
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
            <strong>Design</strong> — a real <em>filter designer</em>. Choose a classic recipe
            (Butterworth, Chebyshev I/II, a windowed-sinc FIR, or an audio biquad) and watch its
            poles and zeros land on the <strong>z-plane</strong> — then drag them by hand and see the
            magnitude, phase, group delay, impulse response and sound all recompute live from a
            from-scratch bilinear transform.
          </li>
          <li>
            <strong>Spectrogram</strong> — a short-time Fourier transform slides a fixed window
            across the signal, producing a time × frequency heatmap. It exposes the time/frequency
            trade-off at the heart of signal processing.
          </li>
          <li>
            <strong>Reassign</strong> — the spectrogram, <em>sharpened</em>. Time-frequency
            reassignment moves every STFT cell to the signal's true local centre of gravity, so a
            fuzzy chirp band collapses to a razor line tracing its instantaneous frequency — and its
            invertible cousin, <strong>synchrosqueezing</strong>. A Rényi-entropy readout quantifies
            the sharpening.
          </li>
          <li>
            <strong>Live</strong> — the whole thing in <em>real time</em>. Every animation frame
            grabs a block of audio from your <strong>microphone</strong> (or a synthetic voice),
            windows it and runs the same from-scratch FFT, producing a live spectrum, a scrolling
            spectrogram, and a pitch <strong>tuner</strong> that names the note you're hearing.
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
            <strong>Tomography</strong> — a CT scanner from scratch. Project a phantom into a{' '}
            <strong>sinogram</strong> of line integrals, then invert it two ways: filtered
            back-projection (watch each reading smear back and resolve into a sharp slice) and a
            direct <strong>Fourier Slice Theorem</strong> reconstruction that grids each
            projection's spectrum into k-space. An RMSE error map and a live view of the radial
            slices filling the frequency plane keep it honest.
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
        <h3>Designing a filter on the z-plane</h3>
        <div className="formula">H(z) = k · ∏ᵢ(z − zᵢ) / ∏ⱼ(z − pⱼ)</div>
        <p>
          A digital filter is fully described by where it puts its <strong>zeros</strong> (which pull
          the response down) and its <strong>poles</strong> (which push it up) inside the complex{' '}
          <code>z</code>-plane. Evaluate <code>H(z)</code> around the unit circle{' '}
          <code>z = e^(jω)</code> and you get the frequency response; a pole near the circle makes a
          resonant peak, a zero on it makes a perfect null. A filter is <strong>stable</strong> only
          when every pole sits strictly inside the circle.
        </p>
        <p>
          The <strong>Design</strong> mode builds the classic filters the textbook way: it lays down
          an analog prototype (Butterworth's maximally-flat pole circle, or a Chebyshev ellipse that
          trades passband ripple for a steeper skirt), applies the analog low-pass →
          high/band/stop frequency transform, then maps the whole s-plane into the z-plane with the{' '}
          <strong>bilinear transform</strong> <code>s = (z−1)/(z+1)</code> — pre-warping the cutoff so
          it lands exactly where you asked. FIR filters take the parallel route: a windowed sinc,
          whose many zeros we recover for the plane by factoring the tap polynomial with a
          from-scratch Durand–Kerner root finder.
        </p>
        <div className="formula">τ(ω) = −dφ/dω = Σⱼ Re[ z/(z−pⱼ) ] − Σᵢ Re[ z/(z−zᵢ) ]</div>
        <p>
          <strong>Group delay</strong> — how long each frequency is held up as it passes through — is
          the negative slope of the phase, computed here exactly from the pole/zero geometry above.
          A linear-phase FIR delays every frequency by the same <code>(N−1)/2</code> samples (a flat
          line); an IIR filter's delay bulges near its cutoff, the price of its efficiency.
        </p>
      </div>

      <div className="card">
        <h3>Optimal filter design — elliptic &amp; Parks–McClellan</h3>
        <p>
          Butterworth spends its whole ripple budget on being flat; Chebyshev lets one band ripple to
          buy a steeper skirt. Push that idea to its limit — ripple equally in <em>both</em> bands —
          and you get the <strong>elliptic (Cauer)</strong> filter, the <em>most selective</em> IIR
          shape that exists for a given order. Its stopband is a row of notches (transmission zeros
          that sit right on the unit circle), and building it needs the machinery of{' '}
          <strong>Jacobi elliptic functions</strong>: we compute the complete elliptic integral{' '}
          <code>K(m)</code> by the arithmetic–geometric mean, the functions <code>sn/cn/dn</code> by
          the descending Landen transformation, the <strong>degree equation</strong> that fixes the
          selectivity from the order and the ripple ratio (through the theta/nome series), and a
          complex inverse <code>sn</code> to place the poles — all from scratch.
        </p>
        <div className="formula">min ‖ W(ω)·[D(ω) − A(ω)] ‖∞  ⇒  equiripple error at r+1 frequencies</div>
        <p>
          The FIR twin is <strong>Parks–McClellan</strong>. Instead of windowing a sinc, it finds the
          linear-phase filter whose <em>worst-case</em> weighted error is as small as possible — the
          Chebyshev (minimax) optimum. By the <strong>alternation theorem</strong>, that filter is the
          unique one whose error ripples with equal amplitude and alternating sign at exactly{' '}
          <code>r+1</code> frequencies, and the <strong>Remez exchange</strong> hunts those
          frequencies down: guess them, solve for the deviation <code>δ</code> in closed form,
          interpolate, then relocate the extrema to the error's peaks and repeat until the ripples
          equalise. Weight the stopband more heavily and the ripples rebalance — deeper rejection for
          a little passband ripple.
        </p>
        <p>
          The <strong>“design to a spec”</strong> panel inverts the whole question. Give it your
          tolerances — passband edge, stopband edge, ripple <code>Rₚ</code>, attenuation{' '}
          <code>R_s</code> — and the classic order formulas (<code>buttord</code>,{' '}
          <code>cheb1ord</code>, <code>ellipord</code> — the ratio of elliptic integrals — and the
          Kaiser FIR-length estimate) return the <em>minimum</em> order of each family that meets
          them. The spec mask drawn over the magnitude plot is the contract; watch each filter kiss
          it, and watch the elliptic reach the floor in the fewest poles.
        </p>
      </div>

      <div className="card">
        <h3>Sharpening the spectrogram — reassignment</h3>
        <div className="formula">ω̂(n,k) = ω_k − Im( X_Dh / X_h ) &nbsp;·&nbsp; t̂(n,k) = n + Re( X_Th / X_h )</div>
        <p>
          A spectrogram blurs each event over its whole window. <strong>Reassignment</strong>{' '}
          (Kodera 1976; Auger &amp; Flandrin 1995) leaves the window alone and instead relocates
          every cell's energy to the signal's local centre of gravity in the plane. Both corrections
          fall out of ratios of STFTs taken with two <em>companion</em> windows built from the same
          analysis window <code>h</code>: the time-ramped window <code>Th = τ·h</code> gives the
          local group delay <code>t̂</code>, and the derivative window <code>Dh = h′</code> gives the
          channelised instantaneous frequency <code>ω̂</code>. We use a Gaussian <code>h</code>, whose
          derivative is exactly <code>−(τ/σ²)·h</code>, so all three windows are analytic. A pure
          tone's energy — spread across several bins by the window — snaps back onto one line;
          a chirp collapses to the curve of its instantaneous frequency.
        </p>
        <p>
          <strong>Synchrosqueezing</strong> (Daubechies–Lu–Wu 2011) reassigns in frequency only,
          keeping the time bin, which makes the transform <em>invertible</em> — you can squeeze then
          reconstruct. The <strong>Rényi entropy</strong> of the energy distribution measures the
          concentration: reassignment provably lowers it, and the app shows the drop in bits.
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
        <h3>Seeing inside — the Fourier Slice Theorem</h3>
        <div className="formula">ℱ₁&#123;p_θ&#125;(ν) = F(ν·cosθ, ν·sinθ)</div>
        <p>
          The <strong>Tomography</strong> mode rests on one of the most beautiful results in all of
          applied mathematics. A CT scanner only ever measures <em>projections</em> — for each angle
          θ, the parallel-beam line integrals <code>p_θ(t) = ∫ f&nbsp;ds</code> that form the{' '}
          <strong>sinogram</strong>. The theorem says the 1-D Fourier transform of that projection is
          exactly a <strong>radial slice</strong>, at angle θ, through the 2-D Fourier transform of
          the object. Collect enough angles and you've sampled the object's entire spectrum on a
          polar grid; one inverse 2-D FFT brings the hidden slice back. The mode shows those slices
          literally lighting up the frequency plane.
        </p>
        <div className="formula">f(x,y) = ∫₀^π Q_θ(x·cosθ + y·sinθ) dθ, &nbsp; Q_θ = ℱ⁻¹&#123;|ν|·ℱp_θ&#125;</div>
        <p>
          Naïvely smearing each projection back across the image (<em>back-projection</em>) blurs
          the result by a <code>1/r</code> point-spread — every point of the object bleeds outward.
          The fix falls straight out of the slice theorem: converting the polar samples to Cartesian
          adds a <code>|ν|</code> Jacobian, and that ramp is precisely the{' '}
          <strong>ramp filter</strong> of <strong>filtered back-projection</strong>. Ram–Lak is the ideal ramp; the Shepp–Logan,
          cosine, Hann and Hamming windows trade a little resolution for noise rejection, exactly the
          knobs a radiologist turns. Everything runs on the same from-scratch FFT — no CT library,
          no linear-algebra package.
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
          harmonic signal. The <strong>filter designer</strong> is held to the same bar: a
          Butterworth low-pass is checked to be exactly −3&nbsp;dB at its cutoff and monotone
          everywhere, Chebyshev's ripple stays inside spec, every classic design across all four
          response types is confirmed stable, a linear-phase FIR's group delay is verified constant,
          the Durand–Kerner root finder is checked against a known factorisation, and — the real
          proof — the FFT of each filter's impulse response is confirmed to match its analytic
          transfer function. Even the live analyser's helpers are covered — equal-temperament note
          mapping (A4 = 440 Hz) and sub-bin parabolic peak refinement — and the newest sharpening
          engine: <strong>reassignment</strong> is confirmed to lock a pure tone onto its true
          frequency and to make a chirp's ridge track its analytic instantaneous frequency to within
          a bin, while synchrosqueezing is checked to leave the time axis untouched. The{' '}
          <strong>tomography</strong> engine is pinned down as well: a disk's Radon transform is
          confirmed angle-independent, projection mass is verified conserved across every angle,
          filtered back-projection is held to a 0.9 correlation on the Shepp–Logan phantom, the
          Fourier-slice reconstruction is confirmed both recognisable and sharper than raw
          back-projection, and the contour tracer is checked to pull a closed, near-circular loop
          out of a disk. Open the console to see all forty-two pass.
        </p>
        <p className="pill">Built with React + TypeScript + Canvas 2D + Web Audio</p>
      </div>
    </div>
  )
}
