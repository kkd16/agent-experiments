import { useEffect, useRef } from 'react';
import { useStore } from './store';

export function AudioSystem() {
  const audioEnabled = useStore(state => state.audioEnabled);
  const timeScale = useStore(state => state.timeScale);
  const distortion = useStore(state => state.distortion);
  const noiseScale = useStore(state => state.noiseScale);
  const evolutionSpeed = useStore(state => state.evolutionSpeed);

  const ctxRef = useRef<AudioContext | null>(null);
  const osc1Ref = useRef<OscillatorNode | null>(null);
  const osc2Ref = useRef<OscillatorNode | null>(null);
  const filterRef = useRef<BiquadFilterNode | null>(null);
  const lfoRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!audioEnabled) {
      if (ctxRef.current && ctxRef.current.state === 'running') {
        ctxRef.current.suspend();
      }
      return;
    }

    if (!ctxRef.current) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return; // not supported

      const ctx = new AudioContextClass();
      ctxRef.current = ctx;

      const gain = ctx.createGain();
      gain.gain.value = 0.1; // master volume
      gain.connect(ctx.destination);
      gainRef.current = gain;

      // Base drone
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = 55; // A1
      osc1Ref.current = osc1;

      const osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.value = 110; // A2
      osc2Ref.current = osc2;

      // Lowpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;
      filter.Q.value = 5;
      filterRef.current = filter;

      // LFO to modulate filter
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.5;
      lfoRef.current = lfo;

      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 300; // Modulation depth

      // Routing
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);

      osc1.start();
      osc2.start();
      lfo.start();
    }

    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume();
    }
  }, [audioEnabled]);

  // Update audio parameters based on state
  useEffect(() => {
    if (!ctxRef.current || !osc1Ref.current || !osc2Ref.current || !filterRef.current || !lfoRef.current || !gainRef.current) return;

    const now = ctxRef.current.currentTime;

    // Distortion increases the second oscillator frequency and master volume slightly
    osc2Ref.current.frequency.setTargetAtTime(110 + distortion * 200, now, 0.1);
    gainRef.current.gain.setTargetAtTime(0.1 + distortion * 0.05, now, 0.1);

    // Noise scale opens up the filter
    filterRef.current.frequency.setTargetAtTime(400 + noiseScale * 300, now, 0.1);

    // Evolution speed changes the LFO rate
    lfoRef.current.frequency.setTargetAtTime(0.1 + evolutionSpeed * 2.0, now, 0.1);

    // Time scale pitches everything up slightly
    osc1Ref.current.detune.setTargetAtTime((timeScale - 1) * 200, now, 0.1);
    osc2Ref.current.detune.setTargetAtTime((timeScale - 1) * 200, now, 0.1);

  }, [distortion, noiseScale, timeScale, evolutionSpeed]);

  return null;
}
