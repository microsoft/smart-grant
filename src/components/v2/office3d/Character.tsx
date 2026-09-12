/**
 * Character — a procedural performer with an articulated rig.
 *
 * What changed from the first pass, and why:
 *
 *   • JOINTS. Limbs were single cylinders rotating from the hip and
 *     shoulder only, which produces a stiff scissor walk. There are now
 *     real knees and elbows, so the walk has a bend, the arms have a
 *     natural counter-swing, and typing reads as forearms on a keyboard
 *     rather than whole arms pivoting from the shoulder.
 *
 *   • THEY SIT. Six desks with no chairs and everyone standing to type was
 *     the biggest realism break in the room. Working characters now lower
 *     onto the chair, thighs forward, shins down.
 *
 *   • BREATHING MOVED. It used to translate the entire body on Y, floating
 *     people through the floor. It now lives on the torso, where lungs are.
 *
 *   • WEIGHT. Movement accelerates and decelerates instead of snapping
 *     between full speed and dead stop, and stride frequency is tied to
 *     actual speed so feet stop skating.
 *
 *   • COLOUR AS FOCUS. Characters wear neutral grey until their agent goes
 *     active, then their shirt blooms into the agent's accent. Combined
 *     with the desaturated set, the only saturated colour in the frame
 *     belongs to whoever is currently working.
 *
 *   • NO REACT IN THE HOT PATH. Typing speed is sampled from the live
 *     channel inside `useFrame`. This component does not re-render on
 *     tokens at all.
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  Color,
  Group,
  MathUtils,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { AgentCharacter } from './cast';
import { COFFEE_TABLE, PALETTE, isBlocked, resolveCollision } from './cast';
import type { CharStatus, LiveChannel, MirrorScene } from './types';

interface CharProps {
  agent: AgentCharacter;
  status: CharStatus;
  scene: MirrorScene;
  live: LiveChannel;
  councilTarget: readonly [number, number];
  doneTarget: readonly [number, number];
  reducedMotion: boolean;
}

type Mode =
  | 'idle'
  | 'wander_out'
  | 'wander_back'
  | 'coffee_out'
  | 'coffee_sip'
  | 'coffee_back'
  | 'working'
  | 'gathering'
  | 'gathered'
  | 'celebrate';

const WALK_SPEED = 1.45;
const ACCEL = 3.2;
const TURN_SPEED = 5.0;
/**
 * Ground speed below this counts as standing still: the stride amount and
 * the stride phase are both forced to zero. Exponential damping only ever
 * approaches zero asymptotically, so without an explicit dead zone a
 * character who has stopped keeps a faint, permanent shuffle.
 */
const SPEED_EPS = 0.05;

/**
 * Steering here is "walk at the target, slide off whatever you hit". That is
 * enough for open floor, but it deadlocks at a box corner: the collision
 * resolver pushes out along the axis of least penetration, and at a corner
 * that axis flips every frame. The body then jitters on the spot forever
 * while `dist` never drops below the arrival threshold — which is exactly
 * what read on screen as a character standing at their desk with the legs
 * still cycling. These two constants bound that failure:
 *
 *   STALL_AFTER   how long without measurable progress counts as stuck.
 *   STALL_EPS     how much closer we must get for it to count as progress.
 */
const STALL_AFTER = 0.9;
const STALL_EPS = 0.03;
/** Lateral offset of the detour waypoint used to walk around an obstacle. */
const DETOUR_RADIUS = 1.15;

/** How far the hips drop when seated. Chair seat top sits at HIP_Y - this. */
const SIT_DROP = 0.26;

// Rig proportions (metres).
const HIP_Y = 0.62;
const THIGH = 0.32;
const SHIN = 0.3;
const SHOULDER_Y = 1.28;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;
const HEAD_Y = 1.5;

export function Character({
  agent,
  status,
  scene,
  live,
  councilTarget,
  doneTarget,
  reducedMotion,
}: CharProps) {
  const groupRef = useRef<Group>(null);
  const torsoRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const hipL = useRef<Group>(null);
  const hipR = useRef<Group>(null);
  const kneeL = useRef<Group>(null);
  const kneeR = useRef<Group>(null);
  const shoulderL = useRef<Group>(null);
  const shoulderR = useRef<Group>(null);
  const elbowL = useRef<Group>(null);
  const elbowR = useRef<Group>(null);

  const stateRef = useRef({
    mode: 'idle' as Mode,
    target: new Vector3(agent.desk[0], 0, agent.desk[1]),
    home: new Vector3(agent.desk[0], 0, agent.desk[1]),
    /** Real destination, held while a detour waypoint occupies `target`. */
    goal: new Vector3(agent.desk[0], 0, agent.desk[1]),
    detourActive: false,
    /** Watchdog: last target seen, best distance reached, and when. */
    lastTx: agent.desk[0],
    lastTz: agent.desk[1],
    bestDist: Infinity,
    bestAt: 0,
    desiredFacing: agent.facing,
    nextDecisionAt: 0,
    sipUntil: 0,
    walkPhase: 0,
    typePhase: 0,
    speed: 0,
    groundSpeed: 0,
    sit: 0,
    activeAmt: 0,
  });

  // ---------------------------------------------------------- materials
  const { skinMat, hairMat, shirtMat, pantsMat } = useMemo(
    () => ({
      skinMat: new MeshStandardMaterial({ color: agent.skin, roughness: 0.72 }),
      hairMat: new MeshStandardMaterial({ color: agent.hair, roughness: 0.55 }),
      shirtMat: new MeshStandardMaterial({
        color: PALETTE.shirtNeutral,
        roughness: 0.78,
      }),
      pantsMat: new MeshStandardMaterial({
        color: PALETTE.pants,
        roughness: 0.85,
      }),
    }),
    [agent.skin, agent.hair],
  );

  // Materials are imperative objects — React will not clean them up.
  useEffect(
    () => () => {
      skinMat.dispose();
      hairMat.dispose();
      shirtMat.dispose();
      pantsMat.dispose();
    },
    [skinMat, hairMat, shirtMat, pantsMat],
  );

  const neutralColor = useMemo(() => new Color(PALETTE.shirtNeutral), []);
  /**
   * The active agent carries colour, but a fully saturated accent across
   * torso and both sleeves reads as a plastic toy under the hero light.
   * Blending most of the way keeps the agent unmistakably identifiable
   * while staying inside the film's warm, desaturated palette.
   */
  const accentColor = useMemo(
    () => new Color(PALETTE.shirtNeutral).lerp(new Color(agent.accent), 0.66),
    [agent.accent],
  );

  // ------------------------------------------------- behaviour switching
  // Deps are primitives and module-stable tuples only. The previous version
  // received a freshly-built array prop, so this effect fired on every token
  // and continuously reset the state machine.
  useEffect(() => {
    const s = stateRef.current;
    if (scene === 'done') {
      s.mode = 'celebrate';
      s.target.set(doneTarget[0], 0, doneTarget[1]);
      return;
    }
    if (scene === 'awaiting_selection') {
      s.mode = 'gathering';
      s.target.set(councilTarget[0], 0, councilTarget[1]);
      return;
    }
    if (status === 'active') {
      s.mode = 'working';
      s.target.copy(s.home);
      s.desiredFacing = agent.facing;
      return;
    }
    if (
      s.mode === 'working' ||
      s.mode === 'gathering' ||
      s.mode === 'gathered' ||
      s.mode === 'celebrate'
    ) {
      s.mode = 'idle';
      s.target.copy(s.home);
      s.desiredFacing = agent.facing;
      s.nextDecisionAt = 0;
    }
  }, [status, scene, councilTarget, doneTarget, agent.facing]);

  // ------------------------------------------------------- per-frame
  useFrame((threeState, rawDelta) => {
    const g = groupRef.current;
    if (!g) return;
    const delta = Math.min(rawDelta, 1 / 20);
    const t = threeState.clock.elapsedTime;
    const s = stateRef.current;
    const i = agent.index;

    // ---- idle scheduler ------------------------------------------
    // Reduced motion keeps everyone at their desk: no wandering, no coffee
    // runs, no ambient traffic.
    if (
      !reducedMotion &&
      (s.mode === 'idle' || s.mode === 'wander_back' || s.mode === 'coffee_back') &&
      t > s.nextDecisionAt &&
      status !== 'active' &&
      scene !== 'awaiting_selection' &&
      scene !== 'done'
    ) {
      const roll = Math.random();
      if (roll < 0.5) {
        let chosen = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          const r = 1.0 + Math.random() * 0.8;
          const a = Math.random() * Math.PI * 2;
          const tx = s.home.x + Math.cos(a) * r;
          const tz = s.home.z + Math.sin(a) * r;
          if (!isBlocked(tx, tz)) {
            s.target.set(tx, 0, tz);
            chosen = true;
            break;
          }
        }
        s.mode = chosen ? 'wander_out' : 'idle';
      } else if (roll < 0.75) {
        s.target.set(
          COFFEE_TABLE[0] + (Math.random() - 0.5) * 0.4,
          0,
          COFFEE_TABLE[1] + 1.0 + Math.random() * 0.2,
        );
        s.mode = 'coffee_out';
      } else {
        s.mode = 'idle';
        s.target.copy(s.home);
      }
      s.nextDecisionAt = t + 6 + Math.random() * 6;
    }

    // ---- locomotion with weight ----------------------------------
    const dx = s.target.x - g.position.x;
    const dz = s.target.z - g.position.z;
    const dist = Math.hypot(dx, dz);
    const wantsToMove = dist > 0.07;

    // ---- stall watchdog -------------------------------------------
    // Reset the progress clock whenever the destination changes, then
    // require the gap to actually shrink. A body that has not closed any
    // ground for STALL_AFTER seconds is wedged, not walking.
    if (s.target.x !== s.lastTx || s.target.z !== s.lastTz) {
      s.lastTx = s.target.x;
      s.lastTz = s.target.z;
      s.bestDist = Infinity;
      s.bestAt = t;
    }
    if (dist < s.bestDist - STALL_EPS) {
      s.bestDist = dist;
      s.bestAt = t;
    }
    if (wantsToMove && t - s.bestAt > STALL_AFTER) {
      if (!s.detourActive) {
        // First recovery: step out sideways and come back at the target
        // from a different angle. This is what a person does when a desk
        // corner is in the way.
        s.goal.copy(s.target);
        const way = sideStep(g.position.x, g.position.z, s.target.x, s.target.z);
        s.detourActive = true;
        s.target.set(way[0], 0, way[1]);
      } else {
        // The detour is wedged too — the destination is simply not
        // reachable from here. Stand down where we are so the state
        // machine advances on the next frame and the legs go still.
        s.detourActive = false;
        s.target.set(g.position.x, 0, g.position.z);
      }
    }

    // Accelerate in, decelerate out — no snapping to full speed.
    const targetSpeed = wantsToMove ? WALK_SPEED : 0;
    s.speed = MathUtils.damp(s.speed, targetSpeed, ACCEL, delta);
    const step = Math.min(s.speed * delta, dist);
    const prevX = g.position.x;
    const prevZ = g.position.z;

    if (wantsToMove && step > 0) {
      const nxRaw = g.position.x + (dx / dist) * step;
      const nzRaw = g.position.z + (dz / dist) * step;
      const [nx, nz] = resolveCollision(nxRaw, nzRaw);
      g.position.x = nx;
      g.position.z = nz;
      s.desiredFacing = Math.atan2(dx, dz);
    } else if (!wantsToMove) {
      // arrived — advance the little state machine
      if (s.detourActive) {
        // Cleared the obstacle; resume the original destination.
        s.detourActive = false;
        s.target.copy(s.goal);
      } else if (s.mode === 'wander_out') {
        s.target.copy(s.home);
        s.mode = 'wander_back';
      } else if (s.mode === 'coffee_out') {
        s.mode = 'coffee_sip';
        s.sipUntil = t + 3.5 + Math.random() * 2.5;
        s.desiredFacing = Math.PI;
      } else if (s.mode === 'coffee_sip') {
        if (t > s.sipUntil) {
          s.target.copy(s.home);
          s.mode = 'coffee_back';
        }
      } else if (s.mode === 'wander_back' || s.mode === 'coffee_back') {
        s.mode = 'idle';
        s.desiredFacing = agent.facing;
      } else if (s.mode === 'gathering') {
        s.mode = 'gathered';
        s.desiredFacing = Math.atan2(-g.position.x, -g.position.z);
      } else if (s.mode === 'celebrate') {
        s.desiredFacing = Math.atan2(-g.position.x, -g.position.z);
      } else if (s.mode === 'working') {
        s.desiredFacing = agent.facing;
      }
    }
    /**
     * The stride is driven by how far the body ACTUALLY travelled this
     * frame, never by the commanded speed. Commanded speed decays
     * exponentially and so never truly reaches zero, which left a standing
     * character with legs that kept twitching; and it holds its full value
     * while a body is wedged against furniture, which read as marching on
     * the spot. Ground truth removes both cases: no displacement, no stride.
     */
    const travelled = Math.hypot(g.position.x - prevX, g.position.z - prevZ);
    s.groundSpeed = MathUtils.damp(
      s.groundSpeed,
      delta > 0 ? travelled / delta : 0,
      14,
      delta,
    );
    if (s.groundSpeed < SPEED_EPS) {
      // Park the cycle at its neutral pose so the legs rest dead straight
      // and the next departure starts from a clean stance.
      s.groundSpeed = 0;
      s.walkPhase = 0;
    } else {
      s.walkPhase += delta * (s.groundSpeed / WALK_SPEED) * 8.5;
    }

    // ---- turn ------------------------------------------------------
    const yawDiff = wrapAngle(s.desiredFacing - g.rotation.y);
    g.rotation.y +=
      Math.min(Math.abs(yawDiff), TURN_SPEED * delta) * Math.sign(yawDiff);

    // ---- sit / stand blend -----------------------------------------
    const wantSit = s.mode === 'working' && !wantsToMove ? 1 : 0;
    s.sit = MathUtils.damp(s.sit, wantSit, 4, delta);
    const sit = s.sit;
    g.position.y = -SIT_DROP * sit;

    // ---- typing energy, sampled from the live channel ---------------
    // The only place token data is read. It never touches React.
    const sinceToken = performance.now() - live.lastAt[i];
    const typingNow = status === 'active' && sinceToken < 500;
    const rate = live.rate[i] || 0;
    const typeFreq = MathUtils.clamp(5 + rate * 0.35, 5, 17);
    if (typingNow) s.typePhase += delta * typeFreq;

    const walkAmt = MathUtils.clamp(s.groundSpeed / WALK_SPEED, 0, 1);
    const swing = Math.sin(s.walkPhase) * 0.55 * walkAmt;

    // ---- legs -------------------------------------------------------
    // Poses below are authored FORWARD-POSITIVE: a positive number means
    // the limb swings toward the character's front. Note that every limb
    // hangs along local -Y, and rotating a downward vector by +x actually
    // carries it toward -Z (backwards), so each value is negated on write.
    // Getting this backwards is what had the cast typing behind their own
    // chairs with their knees pointing at the camera.
    if (hipL.current && hipR.current && kneeL.current && kneeR.current) {
      const bendL =
        Math.max(0, Math.sin(s.walkPhase + Math.PI * 0.35)) * 0.85 * walkAmt;
      const bendR =
        Math.max(0, Math.sin(s.walkPhase + Math.PI * 1.35)) * 0.85 * walkAmt;

      // Seated: thighs forward (+90°), shins back down (-90°) so the net is
      // vertical. Knees flex backwards while walking, as knees do.
      hipL.current.rotation.x = -MathUtils.lerp(swing, Math.PI / 2, sit);
      hipR.current.rotation.x = -MathUtils.lerp(-swing, Math.PI / 2, sit);
      kneeL.current.rotation.x = -MathUtils.lerp(-bendL, -Math.PI / 2, sit);
      kneeR.current.rotation.x = -MathUtils.lerp(-bendR, -Math.PI / 2, sit);
      // Slight splay when seated so the legs aren't perfectly parallel.
      hipL.current.rotation.z = MathUtils.lerp(0, 0.07, sit);
      hipR.current.rotation.z = MathUtils.lerp(0, -0.07, sit);
    }

    // ---- arms -------------------------------------------------------
    if (shoulderL.current && shoulderR.current && elbowL.current && elbowR.current) {
      let shL: number;
      let shR: number;
      let elL: number;
      let elR: number;
      /** Inward tuck, so the hands meet over the keyboard instead of
       *  hovering outside it (shoulders are 0.58 apart, the keyboard is
       *  only 0.48 wide). */
      let armIn = 0;

      if (s.mode === 'working' && sit > 0.35) {
        // Hands on the keyboard. Solved with inverse kinematics rather than
        // eyeballed: the seated shoulder is at y=1.02 and the keys sit at
        // y=0.795, z=0.40 in front of the character, which puts the upper
        // arm 0.43rad forward with a 1.32rad elbow bend — forearms level,
        // elbows just clear of the desk edge.
        const tick = typingNow ? Math.sin(s.typePhase) * 0.1 : 0;
        const tock = typingNow ? Math.sin(s.typePhase + Math.PI) * 0.1 : 0;
        shL = 0.43 + tick * 0.3;
        shR = 0.43 + tock * 0.3;
        elL = 1.32 + tick;
        elR = 1.32 + tock;
        armIn = 0.24;
      } else if (s.mode === 'coffee_sip') {
        shL = -swing * 0.5;
        shR = 0.25;
        elL = 0.16;
        elR = 2.15;
        armIn = 0.2;
      } else if (s.mode === 'celebrate') {
        const cheer = Math.sin(t * 4 + agent.index) * 0.18;
        shL = 2.45 + cheer;
        shR = 2.45 - cheer;
        elL = 0.25;
        elR = 0.25;
      } else {
        // Natural walk: arms counter-swing the legs, elbows slightly bent.
        shL = -swing * 0.62;
        shR = swing * 0.62;
        elL = 0.18 + Math.max(0, -swing) * 0.4;
        elR = 0.18 + Math.max(0, swing) * 0.4;
      }

      // Negated for the same reason as the legs: authored forward-positive,
      // applied to limbs that hang downward.
      const k = 1 - Math.exp(-12 * delta);
      shoulderL.current.rotation.x += (-shL - shoulderL.current.rotation.x) * k;
      shoulderR.current.rotation.x += (-shR - shoulderR.current.rotation.x) * k;
      elbowL.current.rotation.x += (-elL - elbowL.current.rotation.x) * k;
      elbowR.current.rotation.x += (-elR - elbowR.current.rotation.x) * k;
      // +z rotation swings a downward limb toward +x, so the left arm takes
      // the positive value and the right arm the negative one.
      shoulderL.current.rotation.z += (armIn - shoulderL.current.rotation.z) * k;
      shoulderR.current.rotation.z += (-armIn - shoulderR.current.rotation.z) * k;
    }

    // ---- torso: breathing + counter-rotation ------------------------
    if (torsoRef.current) {
      const breath = Math.sin(t * 1.6 + agent.index * 1.7) * 0.008;
      torsoRef.current.position.y = 0.95 + breath;
      torsoRef.current.scale.set(1, 1 + breath * 0.6, 1);
      torsoRef.current.rotation.y = -Math.sin(s.walkPhase) * 0.09 * walkAmt;
      // Lean very slightly into the desk while typing.
      torsoRef.current.rotation.x = MathUtils.lerp(0, 0.12, sit);
    }

    // ---- head -------------------------------------------------------
    if (headRef.current) {
      const look = s.mode === 'working' ? 0.22 * sit : 0;
      const idleGlance =
        reducedMotion || s.mode === 'working'
          ? 0
          : Math.sin(t * 0.4 + agent.index * 2.1) * 0.12;
      headRef.current.rotation.x +=
        (look - headRef.current.rotation.x) * (1 - Math.exp(-8 * delta));
      headRef.current.rotation.y +=
        (idleGlance - headRef.current.rotation.y) * (1 - Math.exp(-3 * delta));
    }

    // ---- colour: only the working agent carries chroma ---------------
    const wantActive = status === 'active' ? 1 : 0;
    s.activeAmt = MathUtils.damp(s.activeAmt, wantActive, 3, delta);
    shirtMat.color.lerpColors(neutralColor, accentColor, s.activeAmt);
  });

  return (
    <group
      ref={groupRef}
      position={[agent.desk[0], 0, agent.desk[1]]}
      rotation={[0, agent.facing, 0]}
    >
      {/* ------------------------------------------------------- LEGS */}
      <group ref={hipL} position={[-0.13, HIP_Y, 0]}>
        <mesh castShadow material={pantsMat} position={[0, -THIGH / 2, 0]}>
          <capsuleGeometry args={[0.085, THIGH - 0.06, 4, 10]} />
        </mesh>
        <group ref={kneeL} position={[0, -THIGH, 0]}>
          <mesh castShadow material={pantsMat} position={[0, -SHIN / 2, 0]}>
            <capsuleGeometry args={[0.075, SHIN - 0.06, 4, 10]} />
          </mesh>
          <mesh castShadow position={[0, -SHIN - 0.03, 0.05]}>
            <boxGeometry args={[0.16, 0.07, 0.24]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.6} />
          </mesh>
        </group>
      </group>
      <group ref={hipR} position={[0.13, HIP_Y, 0]}>
        <mesh castShadow material={pantsMat} position={[0, -THIGH / 2, 0]}>
          <capsuleGeometry args={[0.085, THIGH - 0.06, 4, 10]} />
        </mesh>
        <group ref={kneeR} position={[0, -THIGH, 0]}>
          <mesh castShadow material={pantsMat} position={[0, -SHIN / 2, 0]}>
            <capsuleGeometry args={[0.075, SHIN - 0.06, 4, 10]} />
          </mesh>
          <mesh castShadow position={[0, -SHIN - 0.03, 0.05]}>
            <boxGeometry args={[0.16, 0.07, 0.24]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.6} />
          </mesh>
        </group>
      </group>

      {/* ------------------------------------------------------ TORSO */}
      <group ref={torsoRef} position={[0, 0.95, 0]}>
        <mesh castShadow material={shirtMat}>
          <capsuleGeometry args={[0.235, 0.4, 6, 16]} />
        </mesh>
        <mesh position={[0, 0.3, 0.06]}>
          <cylinderGeometry args={[0.115, 0.13, 0.07, 14]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.7} />
        </mesh>
      </group>

      {/* ------------------------------------------------------- ARMS */}
      <group ref={shoulderL} position={[-0.29, SHOULDER_Y, 0]}>
        <mesh castShadow material={shirtMat} position={[0, -UPPER_ARM / 2, 0]}>
          <capsuleGeometry args={[0.065, UPPER_ARM - 0.05, 4, 10]} />
        </mesh>
        <group ref={elbowL} position={[0, -UPPER_ARM, 0]}>
          <mesh castShadow material={shirtMat} position={[0, -FOREARM / 2, 0]}>
            <capsuleGeometry args={[0.056, FOREARM - 0.05, 4, 10]} />
          </mesh>
          <mesh castShadow material={skinMat} position={[0, -FOREARM - 0.02, 0]}>
            <sphereGeometry args={[0.062, 12, 10]} />
          </mesh>
        </group>
      </group>
      <group ref={shoulderR} position={[0.29, SHOULDER_Y, 0]}>
        <mesh castShadow material={shirtMat} position={[0, -UPPER_ARM / 2, 0]}>
          <capsuleGeometry args={[0.065, UPPER_ARM - 0.05, 4, 10]} />
        </mesh>
        <group ref={elbowR} position={[0, -UPPER_ARM, 0]}>
          <mesh castShadow material={shirtMat} position={[0, -FOREARM / 2, 0]}>
            <capsuleGeometry args={[0.056, FOREARM - 0.05, 4, 10]} />
          </mesh>
          <mesh castShadow material={skinMat} position={[0, -FOREARM - 0.02, 0]}>
            <sphereGeometry args={[0.062, 12, 10]} />
          </mesh>
        </group>
      </group>

      {/* ------------------------------------------------------- HEAD */}
      <group ref={headRef} position={[0, HEAD_Y, 0]}>
        <mesh material={skinMat} position={[0, -0.15, 0]}>
          <cylinderGeometry args={[0.062, 0.072, 0.12, 12]} />
        </mesh>
        <mesh castShadow material={skinMat} scale={[1, 1.08, 0.96]}>
          <sphereGeometry args={[0.185, 26, 20]} />
        </mesh>
        {/* HAIR.
            The old version was an offset squashed sphere whose crown landed
            at y=0.1971 while the skull's reached 0.1998 — so the scalp
            poked through the top and every character looked bald on the
            crown. These two caps are concentric with the skull and share
            its scale, and their radii are strictly larger than the skull's
            0.185, so poke-through is geometrically impossible.
            Cap one covers the crown down to just above the brow. */}
        <mesh castShadow material={hairMat} scale={[1.015, 1.09, 0.985]}>
          <sphereGeometry args={[0.19, 24, 18, 0, Math.PI * 2, 0, 1.3]} />
        </mesh>
        {/* Cap two carries the back and sides lower, to the nape, so it
            reads as a haircut rather than a swim cap. In three.js sphere
            geometry phi runs from +Z, so the back half starts at PI. */}
        <mesh castShadow material={hairMat} scale={[1.015, 1.09, 0.985]}>
          <sphereGeometry
            args={[0.1893, 24, 18, Math.PI * 0.84, Math.PI * 1.32, 0, 1.95]}
          />
        </mesh>
        <mesh position={[-0.066, -0.005, 0.163]}>
          <sphereGeometry args={[0.019, 10, 10]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.25} />
        </mesh>
        <mesh position={[0.066, -0.005, 0.163]}>
          <sphereGeometry args={[0.019, 10, 10]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.25} />
        </mesh>
        <mesh material={skinMat} position={[0, -0.035, 0.175]}>
          <sphereGeometry args={[0.026, 10, 10]} />
        </mesh>
      </group>

      {/* Identity is carried by the desk plaque, the monitor, and the HUD
          card — a floating 3D name tag on top of all three just crowded the
          frame and collided with the plaque behind it. */}
    </group>
  );
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Pick a waypoint perpendicular to the blocked heading so the body can walk
 * around whatever it is pressed against. Both sides are tested against the
 * furniture colliders and the first clear one wins; if the body is boxed in
 * on both sides the original target is returned unchanged, which lets the
 * watchdog fall through to standing down on its next tick.
 */
function sideStep(
  px: number,
  pz: number,
  tx: number,
  tz: number,
): [number, number] {
  const dx = tx - px;
  const dz = tz - pz;
  const len = Math.hypot(dx, dz) || 1;
  // Left-hand normal of the heading.
  const nx = -dz / len;
  const nz = dx / len;
  for (const sign of [1, -1]) {
    const cx = px + nx * sign * DETOUR_RADIUS;
    const cz = pz + nz * sign * DETOUR_RADIUS;
    if (!isBlocked(cx, cz)) return [cx, cz];
  }
  return [tx, tz];
}
