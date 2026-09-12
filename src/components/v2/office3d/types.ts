/**
 * Shared types for the 3D office.
 *
 * The old `MirrorState` + `mirrorReduce` pair lived here and was driven
 * through `useReducer` on every token. That work now belongs to
 * `MirrorStore`, which keeps the token firehose out of React entirely.
 * This module is the small vocabulary the scene components share.
 */

import { Vector3 } from 'three';

export type {
  MirrorScene,
  CharStatus,
  MirrorSnapshot,
  LiveChannel,
} from './mirrorStore';

/**
 * Cinema bus — a single mutable object shared by the director and the
 * post-processing stack.
 *
 * The director writes to it every frame; the effects read from it every
 * frame. Because it is plain mutable state (never React state), the
 * camera can drive depth-of-field focus at 60fps for free.
 */
export interface CinemaBus {
  /** World point the lens is focused on. */
  focusPoint: Vector3;
  /** Distance from camera to `focusPoint`, in metres. */
  focusDistance: number;
  /** 0..1 — how "hot" the current shot is; drives bloom and grade lift. */
  intensity: number;
  /** True when the user has asked for reduced motion. */
  reducedMotion: boolean;
}

export function createCinemaBus(reducedMotion: boolean): CinemaBus {
  return {
    focusPoint: new Vector3(0, 1.3, 0),
    focusDistance: 9,
    intensity: 0,
    reducedMotion,
  };
}
