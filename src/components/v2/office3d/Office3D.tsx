/**
 * Office3D — the stage, the lighting rig, and the projection booth.
 *
 * Changes that matter:
 *
 *   • REACT IS OUT OF THE HOT PATH. State arrives through `MirrorStore`
 *     via `useSyncExternalStore`, which only notifies on genuine
 *     structural transitions (scene / active agent / status). Tokens go
 *     straight to the store's live channel and are sampled inside
 *     `useFrame`. This component re-renders a handful of times per run
 *     instead of hundreds of times per second.
 *
 *   • LIGHT BUDGET. Was 15 dynamic lights (3 pendant + 3 picture + 6
 *     character point lights + 2 directional + hemisphere), which forces
 *     three.js to re-evaluate every light per fragment and recompile
 *     shaders whenever the count changes. Now a fixed 5: ambient,
 *     hemisphere, a shadow-casting window key, a cool fill, and ONE hero
 *     spot that travels to whoever is working.
 *
 *   • THE GPU SLEEPS. The canvas used to render at 60fps forever, even
 *     scrolled out of view. It is now gated on an IntersectionObserver
 *     and on document visibility.
 *
 *   • IT SURVIVES FAILURE. WebGL context loss is caught and surfaced
 *     instead of leaving a black rectangle.
 *
 *   • LOCAL IBL. The environment is generated in-scene rather than
 *     fetched from a CDN, so there is no network dependency and no
 *     Suspense pop.
 */

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, PerformanceMonitor } from '@react-three/drei';
import { motion } from 'framer-motion';
import { Coffee, Sparkles, AlertTriangle, Search, Users } from 'lucide-react';
import { BackSide, Color, MathUtils, Object3D, SpotLight } from 'three';
import { Room } from './Room';
import { Character } from './Character';
import { Effects } from './Effects';
import { Director } from './Director';
import { CAST, DONE_TARGETS, PALETTE } from './cast';
import type { MirrorStore } from './mirrorStore';
import { createCinemaBus, type CinemaBus, type MirrorSnapshot } from './types';

interface Office3DProps {
  store: MirrorStore;
}

export function Office3D({ store }: Office3DProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const reducedMotion = usePrefersReducedMotion();

  // O barramento precisa de identidade estavel: o Director escreve
  // focusPoint, focusDistance e intensity a cada quadro e o Effects le os tres
  // no mesmo quadro. Recria-lo no meio de uma tomada reiniciaria o foco da
  // camera. Por isso `reducedMotion` chega por mutacao e nao como dependencia.
  //
  // A criacao fica num ref, e nao num useMemo com lista vazia, porque useMemo
  // e uma dica de desempenho: o React pode descartar o valor memoizado e
  // chamar a fabrica de novo. Um ref e a unica forma de dizer "exatamente uma
  // vez" e ser levado a serio.
  const cinemaRef = useRef<CinemaBus | null>(null);
  if (cinemaRef.current === null) {
    cinemaRef.current = createCinemaBus(reducedMotion);
  }
  const cinema = cinemaRef.current;
  cinema.reducedMotion = reducedMotion;

  const [quality, setQuality] = useState<'high' | 'low'>('high');
  const [contextLost, setContextLost] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(wrapRef);

  const schoolName = snapshot.schoolName ?? 'Your school';

  const onCreated = useCallback(({ gl }: { gl: { domElement: HTMLCanvasElement } }) => {
    gl.domElement.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        setContextLost(true);
      },
      { passive: false },
    );
    gl.domElement.addEventListener('webglcontextrestored', () => setContextLost(false));
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-2xl border border-claude-border bg-[#141210] shadow-2xl aspect-[4/3] sm:aspect-[16/10] lg:aspect-[2/1]"
    >
      {contextLost ? (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <p className="text-sm text-claude-text-subtle">
            The 3D view lost its graphics context. The application above is
            unaffected — reload the page to bring the office back.
          </p>
        </div>
      ) : (
        <Canvas
          shadows
          flat
          dpr={quality === 'high' ? [1, 1.75] : [1, 1]}
          frameloop={visible ? 'always' : 'never'}
          camera={{ position: [0, 4.45, 11.4], fov: 34, near: 0.1, far: 120 }}
          gl={{ antialias: false, powerPreference: 'high-performance' }}
          onCreated={onCreated}
          aria-label={ariaFor(snapshot, schoolName)}
        >
          <PerformanceMonitor
            onDecline={() => setQuality('low')}
            onIncline={() => setQuality('high')}
          />

          <Lighting snapshot={snapshot} />

          <Room
            schoolName={schoolName}
            grantLabel={snapshot.grantLabel}
            snapshot={snapshot}
            live={store.live}
          />

          {CAST.map((a) => (
            <Character
              key={a.index}
              agent={a}
              status={snapshot.statuses[a.index] ?? 'idle'}
              scene={snapshot.scene}
              live={store.live}
              councilTarget={a.council}
              doneTarget={DONE_TARGETS[a.index]}
              reducedMotion={reducedMotion}
            />
          ))}

          {/* Director runs before Effects so the focus point is fresh. */}
          <Director snapshot={snapshot} cinema={cinema} />
          <Effects cinema={cinema} quality={quality} />

          {/* Environment generated in-scene: image-based lighting with no
              CDN fetch. `frames={1}` bakes it once. */}
          <Environment resolution={64} frames={1}>
            <mesh scale={60}>
              <sphereGeometry args={[1, 12, 12]} />
              <meshBasicMaterial color="#2a2a30" side={BackSide} />
            </mesh>
            <mesh position={[-14, 6, 0]} rotation={[0, Math.PI / 2, 0]} scale={[14, 10, 1]}>
              <planeGeometry />
              <meshBasicMaterial color={PALETTE.sun} />
            </mesh>
            <mesh position={[10, 8, 8]} rotation={[0, -Math.PI / 3, 0]} scale={[10, 8, 1]}>
              <planeGeometry />
              <meshBasicMaterial color={PALETTE.fill} />
            </mesh>
          </Environment>
        </Canvas>
      )}

      <SceneHud snapshot={snapshot} />

      {/* The scene is decorative for assistive tech; this is the text
          equivalent of what it is showing. */}
      <p className="sr-only" role="status" aria-live="polite">
        {ariaFor(snapshot, schoolName)}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lighting — a fixed budget of five                                   */
/* ------------------------------------------------------------------ */

function Lighting({ snapshot }: { snapshot: MirrorSnapshot }) {
  return (
    <>
      <ambientLight intensity={0.5} color="#f3e6d2" />
      <hemisphereLight color="#ffe9cd" groundColor="#3a2f26" intensity={0.55} />
      {/* Window key — the only shadow caster. Bounds cover the whole set;
          the previous ±10 box clipped the corners of a 16×10 room. */}
      <directionalLight
        position={[-9.5, 6.2, 1.5]}
        intensity={2.3}
        color={PALETTE.sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={0.5}
        shadow-camera-far={34}
        shadow-bias={-0.0008}
        shadow-normalBias={0.02}
      />
      {/* Cool bounce from the open side — separates figures from the wall. */}
      <directionalLight position={[7, 4.5, 8]} intensity={0.55} color={PALETTE.fill} />
      <HeroSpot snapshot={snapshot} />
    </>
  );
}

/**
 * HeroSpot — one light that travels.
 *
 * Replaces six per-character point lights that existed simultaneously and
 * cost full price even at zero intensity.
 */
const WARM_WHITE = new Color('#ffe7c8');

function HeroSpot({ snapshot }: { snapshot: MirrorSnapshot }) {
  const lightRef = useRef<SpotLight>(null);
  const target = useMemo(() => new Object3D(), []);
  const accentTint = useMemo(() => new Color(), []);
  const posRef = useRef({ x: 0, z: 0 });

  useFrame((_, rawDelta) => {
    const light = lightRef.current;
    if (!light) return;
    const delta = Math.min(rawDelta, 1 / 20);
    const agent = CAST.find((c) => c.index === snapshot.active);

    if (agent) {
      posRef.current.x = MathUtils.damp(posRef.current.x, agent.desk[0], 4, delta);
      posRef.current.z = MathUtils.damp(posRef.current.z, agent.desk[1], 4, delta);
    }
    light.position.set(posRef.current.x, 3.6, posRef.current.z);
    target.position.set(posRef.current.x, 0.8, posRef.current.z);
    target.updateMatrixWorld();

    light.intensity = MathUtils.damp(light.intensity, agent ? 17 : 0, 3, delta);
    // Tinted toward the agent's accent, but mostly warm white: a fully
    // saturated key light stains the whole desk and breaks the palette.
    if (agent) {
      accentTint.set(agent.accent).lerp(WARM_WHITE, 0.72);
      light.color.copy(accentTint);
    }
  });

  return (
    <>
      <primitive object={target} />
      <spotLight
        ref={lightRef}
        target={target}
        position={[0, 3.6, 0]}
        angle={0.62}
        penumbra={0.85}
        distance={7.5}
        decay={2}
        intensity={0}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* HUD — the app's own design language, not a game overlay             */
/* ------------------------------------------------------------------ */

function SceneHud({ snapshot }: { snapshot: MirrorSnapshot }) {
  const activeAgent = CAST.find((a) => a.index === snapshot.active);
  const meta = SCENE_META[snapshot.scene];

  return (
    <>
      {/* Top-left: where we are in the story. */}
      <div className="pointer-events-none absolute left-4 top-4 z-10">
        <span className="inline-flex items-center gap-2 rounded-full bg-black/30 px-3 py-1.5 text-[11px] font-medium text-white/95 backdrop-blur-md">
          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
      </div>

      {/* Top-right: who is on camera. */}
      {activeAgent && (
        <motion.div
          key={activeAgent.index}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="pointer-events-none absolute right-4 top-4 z-10 rounded-xl bg-black/30 px-3.5 py-2.5 backdrop-blur-md"
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: activeAgent.accent }}
            />
            <span className="font-serif text-[15px] leading-none text-white">
              {activeAgent.name}
            </span>
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-white/60">
            {activeAgent.role}
          </div>
        </motion.div>
      )}

      {/* Bottom: one quiet caption line. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4">
        <div className="mx-auto flex max-w-2xl items-center justify-center gap-2 rounded-full bg-black/30 px-4 py-2 text-center text-[12px] leading-snug text-white/85 backdrop-blur-md">
          {captionFor(snapshot)}
        </div>
      </div>
    </>
  );
}

const SCENE_META: Record<MirrorSnapshot['scene'], { label: string; dot: string }> = {
  idle: { label: 'Office quiet', dot: 'bg-white/40' },
  discovering: { label: 'Searching', dot: 'bg-blue-400 animate-pulse' },
  awaiting_selection: { label: 'Council convening', dot: 'bg-amber-400' },
  generating: { label: 'Writing', dot: 'bg-emerald-400 animate-pulse' },
  done: { label: 'Application ready', dot: 'bg-emerald-400' },
  error: { label: 'Interrupted', dot: 'bg-red-500' },
};

function captionFor(s: MirrorSnapshot) {
  switch (s.scene) {
    case 'idle':
      return (
        <>
          <Coffee className="h-3.5 w-3.5 shrink-0 opacity-70" />
          Pre-shift. Choose a school and a grant above to open the office.
        </>
      );
    case 'discovering':
      return (
        <>
          <Search className="h-3.5 w-3.5 shrink-0 opacity-70" />
          Mara is searching live grant sources. Her screen is the real feed.
        </>
      );
    case 'awaiting_selection':
      return (
        <>
          <Users className="h-3.5 w-3.5 shrink-0 opacity-70" />
          The shortlist is on the table — those are the real ranked grants.
          Choose one above.
        </>
      );
    case 'generating': {
      const a = CAST.find((c) => c.index === s.active);
      return (
        <>
          <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {a
            ? `${a.name} is drafting — the text on the monitor is the live output.`
            : 'Handing off to the next specialist.'}
        </>
      );
    }
    case 'done':
      return (
        <>
          <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-70" />
          Application complete.
        </>
      );
    case 'error':
      return (
        <>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 opacity-70" />
          The run stopped. Details are in the studio above.
        </>
      );
  }
}

function ariaFor(s: MirrorSnapshot, school: string): string {
  const a = CAST.find((c) => c.index === s.active);
  switch (s.scene) {
    case 'idle':
      return 'Illustration of a school grant office, currently idle.';
    case 'discovering':
      return `Illustration: the grants coordinator is searching funding sources for ${school}.`;
    case 'awaiting_selection':
      return `Illustration: the team is reviewing ${s.grantTitles.length} shortlisted grants.`;
    case 'generating':
      return a
        ? `Illustration: ${a.name}, ${a.role}, is drafting the application for ${school}.`
        : 'Illustration: the team is drafting the application.';
    case 'done':
      return `Illustration: the application for ${school} is complete.`;
    case 'error':
      return 'Illustration: the run stopped because of an error.';
  }
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * True only when the element is on screen AND the tab is visible.
 * Drives `frameloop`, so an off-screen office costs nothing.
 */
function useOnScreen(ref: React.RefObject<HTMLElement>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return onScreen && tabVisible;
}
