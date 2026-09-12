/**
 * MirrorStore — the bridge between the WriterStudio's event firehose and
 * the 3D office.
 *
 * The critical design rule: **token events never reach React.**
 *
 * A generation run emits hundreds of tokens per second. The previous
 * implementation appended every one to an array (O(n) copy per token, and
 * the array was never trimmed) and bumped React state, which re-rendered
 * the page, the Studio, and the entire 3D tree on every single token.
 *
 * Here the traffic is split into two channels:
 *
 *   • STRUCTURAL  — scene, active agent, per-agent status, labels, grant
 *                   titles. Changes a handful of times per run. Exposed
 *                   via `useSyncExternalStore`, so React re-renders only
 *                   on genuine structural transitions.
 *
 *   • LIVE        — token counts, typing rate, monitor text. Mutated in
 *                   place on a plain object with a stable identity, and
 *                   read exclusively from inside `useFrame`. React never
 *                   sees it, so it costs zero renders.
 *
 * Nothing is retained: there is no event history, so memory is flat for
 * arbitrarily long runs.
 */

import type { MirrorEvent } from '../WriterStudio';
import { CAST } from './cast';

export type MirrorScene =
  | 'idle'
  | 'discovering'
  | 'awaiting_selection'
  | 'generating'
  | 'done'
  | 'error';

export type CharStatus = 'idle' | 'active' | 'done';

/** Structural snapshot — immutable, replaced only on real transitions. */
export interface MirrorSnapshot {
  scene: MirrorScene;
  /** Currently working agent index, or -1. */
  active: number;
  statuses: Readonly<Record<number, CharStatus>>;
  schoolName: string | null;
  grantLabel: string | null;
  /** Real titles of the ranked grants, printed on the worktable folders. */
  grantTitles: readonly string[];
}

/** How many characters of streamed text each monitor retains. */
const SCREEN_CHARS = 420;

/**
 * High-frequency channel. Stable identity, mutated in place.
 * ONLY read this from inside `useFrame`.
 */
export interface LiveChannel {
  /** Cumulative tokens per agent. */
  readonly tokens: Float32Array;
  /** Smoothed tokens/second per agent — drives typing speed. */
  readonly rate: Float32Array;
  /** performance.now() of the most recent token per agent. */
  readonly lastAt: Float32Array;
  /** Tail of the streamed text per agent — rendered on the monitor. */
  readonly screen: string[];
  /** Bumped whenever any screen text changes, so renderers can skip work. */
  screenRevision: number;
}

const AGENT_COUNT = Math.max(CAST.length, 6);

export const INITIAL_SNAPSHOT: MirrorSnapshot = {
  scene: 'idle',
  active: -1,
  statuses: {},
  schoolName: null,
  grantLabel: null,
  grantTitles: [],
};

function freshLive(): LiveChannel {
  return {
    tokens: new Float32Array(AGENT_COUNT),
    rate: new Float32Array(AGENT_COUNT),
    lastAt: new Float32Array(AGENT_COUNT),
    screen: new Array<string>(AGENT_COUNT).fill(''),
    screenRevision: 0,
  };
}

export class MirrorStore {
  private snapshot: MirrorSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  /** Mutable per-frame channel. Identity is stable for the store's life. */
  readonly live: LiveChannel = freshLive();

  // ------------------------------------------------------------- React API

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };

  getSnapshot = (): MirrorSnapshot => this.snapshot;

  /** SSR/hydration safety — the office is client-only, but be explicit. */
  getServerSnapshot = (): MirrorSnapshot => INITIAL_SNAPSHOT;

  // ------------------------------------------------------------ ingest

  /** Handed to `WriterStudio.onMirror`. Hot path — keep it allocation-free. */
  push = (e: MirrorEvent): void => {
    switch (e.type) {
      case 'token': {
        // ---- LIVE CHANNEL ONLY. No React work whatsoever. ----
        const i = e.index;
        if (i < 0 || i >= AGENT_COUNT) return;
        const now = performance.now();
        const prev = this.live.lastAt[i];
        this.live.tokens[i] += 1;
        if (prev > 0) {
          // Exponentially smoothed rate; dt clamped so a long pause between
          // agents doesn't produce a divide-by-tiny spike.
          const dt = Math.min(Math.max((now - prev) / 1000, 1 / 240), 0.5);
          const inst = 1 / dt;
          this.live.rate[i] = this.live.rate[i] * 0.85 + inst * 0.15;
        }
        this.live.lastAt[i] = now;
        if (e.text) {
          const next = this.live.screen[i] + e.text;
          this.live.screen[i] =
            next.length > SCREEN_CHARS ? next.slice(-SCREEN_CHARS) : next;
          this.live.screenRevision += 1;
        }
        return;
      }

      case 'reset': {
        this.live.tokens.fill(0);
        this.live.rate.fill(0);
        this.live.lastAt.fill(0);
        this.live.screen.fill('');
        this.live.screenRevision += 1;
        this.commit(INITIAL_SNAPSHOT);
        return;
      }

      case 'inputs':
        this.commit({
          ...this.snapshot,
          schoolName: e.schoolName,
          grantLabel: e.grantLabel,
        });
        return;

      case 'grants':
        this.commit({ ...this.snapshot, grantTitles: e.titles.slice(0, 5) });
        return;

      case 'scene':
        if (this.snapshot.scene === e.scene) return;
        this.commit({ ...this.snapshot, scene: e.scene as MirrorScene });
        return;

      case 'agent_active': {
        if (this.snapshot.active === e.index) return;
        // A fresh run for this agent — clear their monitor.
        this.live.screen[e.index] = '';
        this.live.screenRevision += 1;
        this.commit({
          ...this.snapshot,
          active: e.index,
          statuses: { ...this.snapshot.statuses, [e.index]: 'active' },
        });
        return;
      }

      case 'agent_done':
        this.commit({
          ...this.snapshot,
          active: this.snapshot.active === e.index ? -1 : this.snapshot.active,
          statuses: { ...this.snapshot.statuses, [e.index]: 'done' },
        });
        return;
    }
  };

  // ------------------------------------------------------------ internal

  private commit(next: MirrorSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}
