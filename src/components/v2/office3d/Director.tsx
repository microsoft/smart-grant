/**
 * Director — the camera department.
 *
 * The office previously used one fixed camera that never moved. Every
 * ingredient a shot system needs was already in the data (who is working,
 * what scene we are in) but nothing consumed it.
 *
 * This module choreographs the camera like a film:
 *
 *   idle                → slow establishing wide, gentle drift
 *   discovering         → medium on Mara at her desk
 *   awaiting_selection  → crane up and back over the worktable
 *   generating          → medium-close coverage on the active agent
 *   done                → pull back to the celebratory wide
 *   error               → cooler, static wide
 *
 * Transitions are critically damped (no overshoot, no snap), so the camera
 * *glides* between setups the way a dolly does. A layered-sine handheld
 * pass adds life without ever looking noisy, and the focus point is
 * published to the cinema bus so depth of field racks onto whoever is
 * currently speaking.
 */

'use client';

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { CAST, DESK_OFFSET, ROOM, WORKTABLE_POS, type AgentCharacter } from './cast';
import type { CinemaBus, MirrorSnapshot } from './types';

/**
 * Every shot below is composed for a 2:1 frame — the widescreen the office
 * gets on a desktop. The canvas is 4:3 on small screens, and a perspective
 * camera keeps its *vertical* FOV fixed, so a narrower frame silently crops
 * the sides away and the cast walks out of shot.
 */
const REFERENCE_ASPECT = 2.0;
/** Beyond this the wide-angle distortion starts to look like a fisheye. */
const MAX_FOV = 62;

interface DirectorProps {
  snapshot: MirrorSnapshot;
  cinema: CinemaBus;
}

/** A camera setup: where the lens is, what it points at, how tight it is. */
interface Shot {
  pos: Vector3;
  look: Vector3;
  fov: number;
  /** Seconds to settle. Bigger = statelier. */
  smooth: number;
  /** Handheld amplitude multiplier. */
  handheld: number;
}

const HALF_W = ROOM.width / 2;
const HALF_D = ROOM.depth / 2;

/** How far behind the agent the lens sits for an over-the-shoulder. */
const COVERAGE_BACK = 2.85;
/** Lateral offset so the agent's head never eclipses the screen. */
const COVERAGE_SIDE = 1.15;
/** Above the seated agent — high enough to look down the screen's normal. */
const COVERAGE_HEIGHT = 2.72;
/** Roughly the middle of the monitor panel. */
const SCREEN_HEIGHT = 1.1;

/**
 * Build an over-the-shoulder coverage shot for one agent.
 *
 * This has to satisfy a hard constraint: the monitor is the whole point.
 * The office promises that the text on screen is the real model output, so
 * a shot that cannot see the screen is a broken promise.
 *
 * The monitor sits on the desk facing the agent, so its screen normal
 * points *back* at them. The only place a camera can see both the agent
 * and their screen is therefore behind and above the agent, looking down
 * that normal — the classic over-the-shoulder. Placing the lens in front
 * of the agent (the intuitive "see their face" choice) shows the audience
 * the black rear housing of the monitor and nothing else.
 *
 * Every desk faces either a wall or the room edge, so "behind the agent"
 * always resolves toward the middle of the room and the camera stays
 * inside the set. It is clamped anyway.
 */
function coverageShot(agent: AgentCharacter, out: Shot): Shot {
  const cx = agent.desk[0];
  const cz = agent.desk[1];
  // Unit vector the agent is facing.
  const fx = Math.sin(agent.facing);
  const fz = Math.cos(agent.facing);
  // Perpendicular, for the shoulder offset.
  const px = fz;
  const pz = -fx;

  out.pos.set(
    clamp(cx - fx * COVERAGE_BACK + px * COVERAGE_SIDE, -HALF_W + 0.7, HALF_W - 0.7),
    COVERAGE_HEIGHT,
    clamp(cz - fz * COVERAGE_BACK + pz * COVERAGE_SIDE, -HALF_D + 0.7, HALF_D - 0.7),
  );
  // Aim between the agent's shoulders and the screen, so the shot holds
  // both rather than pushing the character out of frame.
  out.look.set(cx + fx * DESK_OFFSET * 0.8, SCREEN_HEIGHT, cz + fz * DESK_OFFSET * 0.8);
  out.fov = 38;
  out.smooth = 1.15;
  out.handheld = 1;
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Critically damped spring (Unity's SmoothDamp). Frame-rate independent,
 * never overshoots, and eases both out of the old value and into the new
 * one — which is exactly the motion signature of a real dolly move.
 */
function smoothDamp(
  current: number,
  target: number,
  velRef: { v: number },
  smoothTime: number,
  dt: number,
): number {
  const omega = 2 / Math.max(smoothTime, 0.0001);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velRef.v + omega * change) * dt;
  velRef.v = (velRef.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

export function Director({ snapshot, cinema }: DirectorProps) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;

  const rig = useMemo(
    () => ({
      pos: new Vector3(0, 4.4, 11.5),
      look: new Vector3(0, 1.25, -0.3),
      fov: 34,
      // per-axis velocities for the damping
      vp: [{ v: 0 }, { v: 0 }, { v: 0 }],
      vl: [{ v: 0 }, { v: 0 }, { v: 0 }],
      vf: { v: 0 },
      shot: {
        pos: new Vector3(),
        look: new Vector3(),
        fov: 34,
        smooth: 1.2,
        handheld: 1,
      } as Shot,
      finalLook: new Vector3(),
    }),
    [],
  );

  const bootRef = useRef(true);

  useFrame((state, rawDelta) => {
    // Clamp delta so a tab-restore or a long GC pause can't teleport the rig.
    const dt = Math.min(rawDelta, 1 / 20);
    const t = state.clock.elapsedTime;
    const reduced = cinema.reducedMotion;
    const shot = rig.shot;

    // ---------------------------------------------------- choose the shot
    const activeAgent =
      snapshot.active >= 0
        ? CAST.find((c) => c.index === snapshot.active) ?? null
        : null;

    switch (snapshot.scene) {
      case 'discovering':
      case 'generating': {
        if (activeAgent) {
          coverageShot(activeAgent, shot);
        } else {
          // Between agents — hold a calm wide so the cut has somewhere to land.
          shot.pos.set(0, 4.0, 9.6);
          shot.look.set(0, 1.25, -0.2);
          shot.fov = 36;
          shot.smooth = 1.4;
          shot.handheld = 0.7;
        }
        break;
      }

      case 'awaiting_selection': {
        // Crane up and back: the whole team is around the table, and the
        // audience needs to read the folders.
        shot.pos.set(WORKTABLE_POS[0], 5.5, WORKTABLE_POS[1] + 6.7);
        shot.look.set(WORKTABLE_POS[0], 1.0, WORKTABLE_POS[1] - 0.1);
        shot.fov = 38;
        shot.smooth = 1.7;
        shot.handheld = 0.5;
        break;
      }

      case 'done': {
        shot.pos.set(0, 4.9, 10.4);
        shot.look.set(0, 1.2, 0.2);
        shot.fov = 40;
        shot.smooth = 2.0;
        shot.handheld = 0.6;
        break;
      }

      case 'error': {
        shot.pos.set(0, 3.5, 10.0);
        shot.look.set(0, 1.2, 0);
        shot.fov = 34;
        shot.smooth = 1.6;
        shot.handheld = 0.3;
        break;
      }

      case 'idle':
      default: {
        // Establishing wide with a slow lateral drift, like a locked-off
        // camera on a very slow dolly. Reduced motion pins it still.
        const drift = reduced ? 0 : Math.sin(t * 0.06) * 1.5;
        const rise = reduced ? 0 : Math.sin(t * 0.043 + 1.1) * 0.22;
        shot.pos.set(drift, 4.45 + rise, 11.4);
        shot.look.set(drift * 0.25, 1.25, -0.3);
        shot.fov = 34;
        shot.smooth = 2.2;
        shot.handheld = 0.8;
        break;
      }
    }

    // ------------------------------------------- hold the horizontal frame
    // Widen the vertical FOV as the canvas narrows so the same amount of
    // room stays in shot. Blended rather than fully matched: a full match
    // on a tall phone frame would fill the screen with floor and ceiling.
    const aspect = camera.aspect || REFERENCE_ASPECT;
    if (aspect < REFERENCE_ASPECT) {
      const tanHalf = Math.tan((shot.fov * Math.PI) / 360);
      const matched =
        (2 * Math.atan((tanHalf * REFERENCE_ASPECT) / aspect) * 180) / Math.PI;
      shot.fov = Math.min(MathUtils.lerp(shot.fov, matched, 0.72), MAX_FOV);
    }

    // ---------------------------------------------------- damp toward it
    if (bootRef.current) {
      // First frame: adopt the shot exactly, so we don't fly in from the origin.
      rig.pos.copy(shot.pos);
      rig.look.copy(shot.look);
      rig.fov = shot.fov;
      bootRef.current = false;
    } else {
      const s = reduced ? shot.smooth * 1.6 : shot.smooth;
      rig.pos.set(
        smoothDamp(rig.pos.x, shot.pos.x, rig.vp[0], s, dt),
        smoothDamp(rig.pos.y, shot.pos.y, rig.vp[1], s, dt),
        smoothDamp(rig.pos.z, shot.pos.z, rig.vp[2], s, dt),
      );
      rig.look.set(
        smoothDamp(rig.look.x, shot.look.x, rig.vl[0], s * 0.85, dt),
        smoothDamp(rig.look.y, shot.look.y, rig.vl[1], s * 0.85, dt),
        smoothDamp(rig.look.z, shot.look.z, rig.vl[2], s * 0.85, dt),
      );
      rig.fov = smoothDamp(rig.fov, shot.fov, rig.vf, s, dt);
    }

    // ---------------------------------------------------- handheld pass
    // Layered sines at incommensurable frequencies: organic, never loops
    // visibly, and costs nothing. Applied AFTER damping so it never fights
    // the spring.
    let hx = 0;
    let hy = 0;
    if (!reduced) {
      const a = 0.016 * shot.handheld;
      hx = (Math.sin(t * 0.73) * 0.6 + Math.sin(t * 1.71 + 1.3) * 0.4) * a;
      hy = (Math.sin(t * 0.61 + 2.1) * 0.6 + Math.sin(t * 1.43) * 0.4) * a;
    }

    camera.position.set(rig.pos.x + hx, rig.pos.y + hy, rig.pos.z);
    rig.finalLook.copy(rig.look);
    camera.lookAt(rig.finalLook);

    if (Math.abs(camera.fov - rig.fov) > 0.01) {
      camera.fov = rig.fov;
      camera.updateProjectionMatrix();
    }

    // ---------------------------------------------------- publish the lens
    cinema.focusPoint.copy(rig.look);
    cinema.focusDistance = camera.position.distanceTo(rig.look);

    // Bloom/grade lift rises when someone is actually working.
    const wantIntensity =
      snapshot.scene === 'generating' || snapshot.scene === 'discovering'
        ? activeAgent
          ? 1
          : 0.45
        : snapshot.scene === 'done'
          ? 0.85
          : 0.25;
    cinema.intensity += (wantIntensity - cinema.intensity) * Math.min(dt * 2, 1);
  });

  return null;
}
