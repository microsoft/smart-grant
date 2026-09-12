/**
 * Effects — the post-processing chain, i.e. the difference between
 * "a WebGL demo" and "a frame of film".
 *
 * The scene previously rendered raw: no bloom, no depth of field, no tone
 * mapping, no vignette. Flat-lit primitives straight to the screen.
 *
 * The chain here is deliberately short — five passes, each doing one job:
 *
 *   DepthOfField → racks focus onto whoever the director is covering, so
 *                  the working agent separates from the set. The focus
 *                  point comes off the cinema bus at 60fps, mutated in
 *                  place, so it costs zero React renders.
 *   Bloom        → lets the monitors and the window actually read as light
 *                  sources instead of as bright stickers.
 *   ToneMapping  → ACES filmic. Rolls off highlights the way film does
 *                  rather than clipping to white.
 *   Vignette     → gently pulls the eye to centre frame.
 *   Noise        → a whisper of grain. Kills banding in the soft gradients
 *                  and stops the image looking synthetically clean.
 *
 * The Canvas renders with `flat` (NoToneMapping) so ACES is applied here,
 * once, at the correct point in the chain.
 */

'use client';

import { useRef, type Ref } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Bloom,
  DepthOfField,
  EffectComposer,
  Noise,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing';
import {
  BlendFunction,
  ToneMappingMode,
  type BloomEffect,
  type DepthOfFieldEffect,
} from 'postprocessing';
import { Vector3 } from 'three';
import type { CinemaBus } from './types';

interface EffectsProps {
  cinema: CinemaBus;
  /** Lowered on weak hardware. */
  quality: 'high' | 'low';
}

export function Effects({ cinema, quality }: EffectsProps) {
  const dofRef = useRef<DepthOfFieldEffect | null>(null);
  const bloomRef = useRef<BloomEffect | null>(null);
  const reduced = cinema.reducedMotion;
  useFrame(() => {
    // ---- focus rack -------------------------------------------------
    const dof = dofRef.current;
    if (dof) {
      // `target` is null until first assigned; the typings claim otherwise.
      if (!dof.target) dof.target = new Vector3();
      dof.target.copy(cinema.focusPoint);
    }

    // ---- bloom breathes with the shot -------------------------------
    const bloom = bloomRef.current;
    if (bloom) {
      const want = 0.34 + cinema.intensity * 0.34;
      bloom.intensity += (want - bloom.intensity) * 0.06;
    }
  });

  return (
    // No normal pass: nothing in the chain consumes normals, and skipping
    // it saves a full scene re-render every frame.
    <EffectComposer multisampling={quality === 'high' ? 4 : 0}>
      <DepthOfField
        ref={dofRef}
        worldFocusDistance={9}
        worldFocusRange={quality === 'high' ? 3.4 : 5.0}
        bokehScale={quality === 'high' ? 2.6 : 1.6}
        resolutionScale={quality === 'high' ? 0.75 : 0.5}
      />
      <Bloom
        // The library types this ref as the class rather than an instance;
        // the cast reconciles that without weakening the ref's own type.
        ref={bloomRef as unknown as Ref<typeof BloomEffect>}
        mipmapBlur
        intensity={0.4}
        luminanceThreshold={0.62}
        luminanceSmoothing={0.3}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.26} darkness={0.62} />
      <Noise
        premultiply
        blendFunction={BlendFunction.OVERLAY}
        opacity={reduced ? 0 : 0.035}
      />
    </EffectComposer>
  );
}
