/**
 * /v2/office cast and stage layout. World units = meters.
 * Y is up; the floor sits at y=0. The room spans roughly
 * x ∈ [-7.5, 7.5], z ∈ [-5, 5].
 */

export interface AgentCharacter {
  /** Backend agent index (0-5) matching WriterStudio. */
  index: number;
  /** Short first name shown on the desk plaque. */
  name: string;
  /** Job title — also shown on the desk plaque. */
  role: string;
  /** Outfit + accent color (also used for desk monitor glow when active). */
  accent: string;
  skin: string;
  hair: string;
  /** Home position — where the desk is. Character stands just BEHIND it
   *  (slightly higher z than the desk). */
  desk: [number, number];
  /** Direction the character faces when at desk (radians around Y). */
  facing: number;
  /** Position in the council circle around the worktable (when scene='awaiting_selection'). */
  council: [number, number];
}

export const ROOM = {
  width: 16,
  depth: 10,
  height: 5,
};

/**
 * How far the desk sits in front of the character, along their facing
 * vector. Single source of truth — `Room` draws the desk here and
 * `buildObstacles` blocks the same spot.
 */
export const DESK_OFFSET = 0.6;

/**
 * The cinema palette.
 *
 * Art direction rule: the SET is a restrained warm neutral — near
 * monochrome, low saturation, separated by value and light rather than by
 * hue. The only saturated colour allowed in frame belongs to the agent who
 * is currently working. When nobody is working, the room is essentially
 * greyscale. This is what makes the eye land on the story automatically
 * instead of fighting twelve competing hues.
 */
export const PALETTE = {
  /** Floor — desaturated warm oak. */
  floor: '#6f5d4c',
  floorDark: '#5b4b3d',
  /** Walls — warm plaster, very low chroma. */
  wall: '#cdc3b5',
  wallShadowed: '#b8ad9e',
  /** Trim, desk legs, frames. */
  trim: '#4a3f35',
  /** Desk and table surfaces. */
  surface: '#8a7562',
  surfaceDark: '#6b5a4a',
  /** Rug. */
  rug: '#8d8175',
  /** Neutral shirt colour — characters wear this until they go active. */
  shirtNeutral: '#9a9086',
  /** Trousers. */
  pants: '#4c4640',
  /** Paper, plaques, mugs. */
  paper: '#e8e1d6',
  /** Screen glass when dark. */
  screenOff: '#22201e',
  /** The warm key coming through the window. */
  sun: '#ffd9a3',
  /** Cool bounce fill from the open side. */
  fill: '#b9c9e0',
} as const;

export const COFFEE_TABLE: [number, number] = [-5.5, 2.5];
export const WORKTABLE_POS: [number, number] = [0, 0.5];
export const PRINCIPAL_DOOR_POS: [number, number] = [6.5, -4.6];

export const CAST: ReadonlyArray<AgentCharacter> = [
  {
    index: 0,
    name: 'Mara',
    role: 'Grants Coordinator',
    accent: '#3b82f6',
    skin: '#e8b48a',
    hair: '#3b2616',
    desk: [-5, -3],
    facing: Math.PI * 0.45,
    council: [-1.95, 0.5],
  },
  {
    index: 1,
    name: 'Theo',
    role: 'Program Director',
    accent: '#0d9488',
    skin: '#c98e6b',
    hair: '#1b1b1b',
    desk: [-2.2, -3.4],
    facing: Math.PI,
    council: [-0.85, -0.75],
  },
  {
    index: 2,
    name: 'Iris',
    role: 'Business Manager',
    accent: '#d97706',
    skin: '#f3c89a',
    hair: '#7c2d12',
    desk: [1.2, -3.4],
    facing: Math.PI,
    council: [0.35, -0.75],
  },
  {
    index: 3,
    name: 'Owen',
    role: 'Title I Coordinator',
    accent: '#dc2626',
    skin: '#b27a4f',
    hair: '#222222',
    desk: [4.2, -3],
    facing: -Math.PI * 0.45,
    council: [1.95, 0.5],
  },
  {
    index: 4,
    name: 'Sage',
    role: 'Data Coach',
    accent: '#7c3aed',
    skin: '#eac4a4',
    hair: '#4a2e09',
    desk: [5.6, 0.5],
    facing: -Math.PI * 0.5,
    council: [0.9, 1.75],
  },
  {
    index: 5,
    name: 'Ben',
    role: 'Assistant Principal',
    accent: '#10b981',
    skin: '#ddae89',
    hair: '#0f172a',
    desk: [4.0, 3.2],
    facing: -Math.PI * 0.75,
    council: [-0.45, 1.75],
  },
];

/** Short label shown in the speech bubble while the character is working. */
export const TASK_LABELS: ReadonlyArray<string> = [
  'Searching grants…',
  'Drafting narrative…',
  'Building budget…',
  'Checking compliance…',
  'Crunching data…',
  'Final review…',
];

/**
 * Where each character stands for the closing celebration.
 *
 * Each spot is its council position pushed 0.9m radially away from the
 * worktable. That matters for two reasons. Steering here is "walk at the
 * target and slide off anything you hit", which deadlocks at a box corner
 * if the target is on the far side of the table — moving straight outward
 * can never intersect the only obstacle in the middle of the room, so the
 * walk is always a clean straight line. And on arrival everyone turns to
 * face the origin, so stepping back from the table leaves the whole team
 * ringed around it looking in.
 */
export const DONE_TARGETS: ReadonlyArray<readonly [number, number]> = [
  [-2.85, 0.5],
  [-1.36, -1.49],
  [0.59, -1.62],
  [2.85, 0.5],
  [1.43, 2.48],
  [-0.76, 2.6],
];

/**
 * A rectangular, rotatable no-walk zone matching a piece of furniture.
 *
 * These used to be circles, which cannot describe a desk. A desk is 1.4m
 * wide and 0.7m deep and its occupant stands 0.6m behind the centre, so any
 * circle large enough to cover the desk also swallowed the chair. The old
 * code worked around that by exempting each agent from their own desk —
 * which is exactly why agents walked straight through the furniture they
 * work at. A box has no such conflict: the desk's near edge is 0.35m from
 * its centre, leaving the seat comfortably outside.
 */
export interface Obstacle {
  /** Centre in world space. */
  x: number;
  z: number;
  /** Half-extent across the piece (local X). */
  hw: number;
  /** Half-extent through the piece (local Z). */
  hd: number;
  /** Yaw, matching how Room draws it. */
  rot: number;
}

/**
 * Roughly the radius of a character's body. Used as the collision skin so
 * they stop with their belly at the desk edge rather than clipping into it.
 */
export const BODY_PAD = 0.2;

/** Build the obstacle list from the same source-of-truth as the room geometry. */
function buildObstacles(): Obstacle[] {
  const list: Obstacle[] = [
    // Worktable — Room draws it 2.6 × 1.4.
    { x: WORKTABLE_POS[0], z: WORKTABLE_POS[1], hw: 1.3, hd: 0.7, rot: 0 },
    // Coffee table — a 0.55 radius cylinder.
    { x: COFFEE_TABLE[0], z: COFFEE_TABLE[1], hw: 0.55, hd: 0.55, rot: 0 },
  ];
  // One box per desk, matching Room's 1.4 × 0.7 top and its yaw. The depth
  // is trimmed very slightly so a seated agent's knees can tuck under the
  // edge without the solver fighting them.
  for (const a of CAST) {
    list.push({
      x: a.desk[0] + Math.sin(a.facing) * DESK_OFFSET,
      z: a.desk[1] + Math.cos(a.facing) * DESK_OFFSET,
      hw: 0.72,
      hd: 0.3,
      rot: a.facing,
    });
  }
  return list;
}

export const OBSTACLES: ReadonlyArray<Obstacle> = buildObstacles();

/** World point → obstacle-local coordinates. */
function toLocal(x: number, z: number, o: Obstacle): [number, number] {
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  const rx = x - o.x;
  const rz = z - o.z;
  return [rx * c - rz * s, rx * s + rz * c];
}

/** Returns true if (x,z) sits inside any piece of furniture. */
export function isBlocked(x: number, z: number, pad = BODY_PAD): boolean {
  for (const o of OBSTACLES) {
    const [lx, lz] = toLocal(x, z, o);
    if (Math.abs(lx) < o.hw + pad && Math.abs(lz) < o.hd + pad) return true;
  }
  return false;
}

/**
 * Resolve a move against the furniture.
 *
 * On overlap the character is pushed out along the axis of *least*
 * penetration, which makes them slide along a desk edge instead of popping
 * around it. Several passes let inside-corner overlaps settle.
 */
export function resolveCollision(
  x: number,
  z: number,
  pad = BODY_PAD,
): [number, number] {
  let cx = x;
  let cz = z;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const o of OBSTACLES) {
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      const rx = cx - o.x;
      const rz = cz - o.z;
      let lx = rx * c - rz * s;
      let lz = rx * s + rz * c;

      const ex = o.hw + pad;
      const ez = o.hd + pad;
      const px = ex - Math.abs(lx);
      const pz = ez - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue; // outside this box

      if (px < pz) lx = lx < 0 ? -ex : ex;
      else lz = lz < 0 ? -ez : ez;

      // local → world
      cx = o.x + lx * c + lz * s;
      cz = o.z - lx * s + lz * c;
      moved = true;
    }
    if (!moved) break;
  }
  return [cx, cz];
}
