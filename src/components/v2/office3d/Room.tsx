/**
 * Room — the set.
 *
 * Art-direction changes from the first pass:
 *
 *   • PALETTE COLLAPSE. The set was ~12 competing hues (oak floor, cream
 *     walls, tan rug, violet ring, navy/gold crest, plus six saturated
 *     agent accents). It is now a warm near-monochrome built from
 *     `PALETTE`, separated by value and light rather than hue. The only
 *     saturated colour in frame belongs to the agent currently working.
 *
 *   • CHAIRS. Six desks with nobody able to sit was the loudest realism
 *     break in the room. Every desk now has one, at the height the
 *     character rig actually sits at.
 *
 *   • A CEILING. The room was open-topped, so the environment HDRI leaked
 *     into the top of frame on every wide shot.
 *
 *   • REAL DATA. The folders on the worktable carry the actual ranked
 *     grant titles, and the active agent's monitor renders the actual
 *     streamed text. The scene is now evidence, not decoration.
 *
 *   • LIGHT BUDGET. Six per-character point lights and three picture
 *     lights are gone (see `Office3D`, which now runs a single moving hero
 *     spot). Fixtures here are geometry and emissive material only.
 */

'use client';

import { useRef } from 'react';
import { RoundedBox, Text, Billboard } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { DoubleSide } from 'three';
import {
  CAST,
  ROOM,
  COFFEE_TABLE,
  WORKTABLE_POS,
  PRINCIPAL_DOOR_POS,
  DESK_OFFSET,
  PALETTE,
} from './cast';
import type { LiveChannel, MirrorSnapshot } from './types';

interface RoomProps {
  schoolName: string;
  grantLabel: string | null;
  snapshot: MirrorSnapshot;
  live: LiveChannel;
}

export function Room({ schoolName, grantLabel, snapshot, live }: RoomProps) {
  const halfW = ROOM.width / 2;
  const halfD = ROOM.depth / 2;

  return (
    <group>
      {/* ----------------------------------------------------- FLOOR */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
        <meshStandardMaterial color={PALETTE.floor} roughness={0.62} metalness={0.04} />
      </mesh>
      {/* rug — value contrast only, no hue */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0.5]} receiveShadow>
        <planeGeometry args={[5.4, 3.6]} />
        <meshStandardMaterial color={PALETTE.rug} roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0.5]}>
        <ringGeometry args={[2.4, 2.52, 64]} />
        <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.9} side={DoubleSide} />
      </mesh>

      {/* --------------------------------------------------- CEILING */}
      {/* Closes the box so the environment map stops leaking into wides. */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, ROOM.height, 0]}>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
        <meshStandardMaterial color={PALETTE.wallShadowed} roughness={1} />
      </mesh>

      {/* ------------------------------------------------- BACK WALL */}
      <mesh receiveShadow position={[0, ROOM.height / 2, -halfD]}>
        <planeGeometry args={[ROOM.width, ROOM.height]} />
        <meshStandardMaterial color={PALETTE.wall} roughness={0.97} />
      </mesh>
      <mesh position={[0, 0.12, -halfD + 0.02]}>
        <boxGeometry args={[ROOM.width, 0.25, 0.04]} />
        <meshStandardMaterial color={PALETTE.trim} roughness={0.7} />
      </mesh>

      {/* school crest */}
      <group position={[-0.5, 3.4, -halfD + 0.05]}>
        <mesh>
          <planeGeometry args={[1.5, 1.8]} />
          <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.85} />
        </mesh>
        <Text position={[0, 0.28, 0.01]} fontSize={0.2} color={PALETTE.paper} anchorX="center" anchorY="middle" maxWidth={1.4}>
          SCHOOL
        </Text>
        <Text position={[0, 0.02, 0.01]} fontSize={0.14} color={PALETTE.paper} anchorX="center" anchorY="middle">
          OFFICE
        </Text>
        <Text position={[0, -0.48, 0.01]} fontSize={0.075} color={PALETTE.rug} anchorX="center" anchorY="middle" maxWidth={1.3}>
          EST. 1973
        </Text>
      </group>

      {/* tonal wall studies — no picture lights, no chroma */}
      <WallArt position={[-6, 1.7, -halfD + 0.06]} variant="a" />
      <WallArt position={[-3, 1.7, -halfD + 0.06]} variant="b" />
      <WallArt position={[4.6, 1.5, -halfD + 0.06]} variant="c" />

      {/* school name plaque */}
      <group position={[2.0, 2.9, -halfD + 0.05]}>
        <mesh>
          <planeGeometry args={[4.2, 0.55]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.9} />
        </mesh>
        <Text position={[0, 0, 0.01]} fontSize={0.18} color={PALETTE.trim} anchorX="center" anchorY="middle" maxWidth={4.0}>
          {schoolName}
        </Text>
      </group>

      {grantLabel && (
        <Text
          position={[0, 4.2, -halfD + 0.05]}
          fontSize={0.13}
          color={PALETTE.rug}
          anchorX="center"
          anchorY="middle"
          maxWidth={6.0}
        >
          {`Working on: ${grantLabel}`}
        </Text>
      )}

      {/* ------------------------------------------------- LEFT WALL */}
      <mesh receiveShadow rotation={[0, Math.PI / 2, 0]} position={[-halfW, ROOM.height / 2, 0]}>
        <planeGeometry args={[ROOM.depth, ROOM.height]} />
        <meshStandardMaterial color={PALETTE.wallShadowed} roughness={0.97} side={DoubleSide} />
      </mesh>

      {/* WINDOW — the emotional anchor. Bloom turns this into real light. */}
      <group position={[-halfW + 0.03, 2.6, -1]} rotation={[0, Math.PI / 2, 0]}>
        <mesh>
          <planeGeometry args={[3.6, 2.2]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[3.4, 2.0]} />
          <meshStandardMaterial
            color={PALETTE.sun}
            emissive={PALETTE.sun}
            emissiveIntensity={2.4}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[0.06, 2.0, 0.02]} />
          <meshStandardMaterial color={PALETTE.trim} />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <boxGeometry args={[3.4, 0.06, 0.02]} />
          <meshStandardMaterial color={PALETTE.trim} />
        </mesh>
      </group>

      {/* -------------------------------------------- PRINCIPAL DOOR */}
      <group position={[PRINCIPAL_DOOR_POS[0], 1.25, -halfD + 0.03]}>
        <mesh>
          <planeGeometry args={[1.6, 2.5]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.75} />
        </mesh>
        <mesh position={[0, 0.4, 0.01]}>
          <planeGeometry args={[1.3, 1.4]} />
          <meshStandardMaterial color={PALETTE.wall} opacity={0.8} transparent roughness={0.4} />
        </mesh>
        <Text position={[0, 0.55, 0.02]} fontSize={0.12} color={PALETTE.trim} anchorX="center" anchorY="middle">
          PRINCIPAL
        </Text>
        <Text position={[0, 0.38, 0.02]} fontSize={0.075} color={PALETTE.trim} anchorX="center" anchorY="middle">
          REYES
        </Text>
        <mesh position={[0.55, -0.3, 0.03]}>
          <sphereGeometry args={[0.05, 12, 12]} />
          <meshStandardMaterial color={PALETTE.rug} metalness={0.7} roughness={0.35} />
        </mesh>
      </group>

      {/* ------------------------------------------------ SET DRESSING */}
      <FilingCabinet position={[-7.0, 0, -1.6]} />
      <FilingCabinet position={[-7.0, 0, -0.2]} />
      <Plant position={[6.9, 0, 1.4]} />
      <Plant position={[-6.6, 0, 4.0]} />

      {/* ------------------------------------------------------ DESKS */}
      {CAST.map((a) => (
        <Workstation
          key={a.index}
          index={a.index}
          x={a.desk[0]}
          z={a.desk[1]}
          facing={a.facing}
          accent={a.accent}
          name={a.name}
          role={a.role}
          active={snapshot.active === a.index}
          done={snapshot.statuses[a.index] === 'done'}
          live={live}
        />
      ))}

      {/* -------------------------------------------------- WORKTABLE */}
      <group position={[WORKTABLE_POS[0], 0, WORKTABLE_POS[1]]}>
        <RoundedBox args={[2.6, 0.08, 1.4]} radius={0.04} smoothness={4} position={[0, 0.72, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={PALETTE.surface} roughness={0.6} />
        </RoundedBox>
        {[
          [-1.2, -0.6],
          [1.2, -0.6],
          [-1.2, 0.6],
          [1.2, 0.6],
        ].map(([x, z], i) => (
          <mesh key={i} position={[x, 0.36, z]} castShadow>
            <cylinderGeometry args={[0.04, 0.04, 0.72, 8]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.7} />
          </mesh>
        ))}
        {snapshot.scene === 'awaiting_selection' && (
          <FoldersOnTable titles={snapshot.grantTitles} />
        )}
      </group>

      {/* ------------------------------------------------ COFFEE TABLE */}
      <group position={[COFFEE_TABLE[0], 0, COFFEE_TABLE[1]]}>
        <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.55, 0.55, 0.08, 24]} />
          <meshStandardMaterial color={PALETTE.surface} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.2, 0]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.4, 8]} />
          <meshStandardMaterial color={PALETTE.trim} />
        </mesh>
        <mesh position={[0.15, 0.6, 0]} castShadow>
          <cylinderGeometry args={[0.08, 0.1, 0.3, 12]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.35} metalness={0.45} />
        </mesh>
        {[
          [-0.25, 0],
          [-0.1, 0.18],
          [-0.25, -0.18],
        ].map(([mx, mz], i) => (
          <mesh key={i} position={[mx, 0.5, mz]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 0.1, 12]} />
            <meshStandardMaterial color={PALETTE.paper} roughness={0.8} />
          </mesh>
        ))}
      </group>

      {/* ------------------------------------------------- PENDANTS */}
      {/* Fixtures are geometry + emissive only. The room's actual light
          comes from the window key and the moving hero spot. */}
      {[[-3, -1], [3, -1], [0, 2]].map(([x, z], i) => (
        <group key={i} position={[x, ROOM.height - 0.6, z]}>
          <mesh castShadow>
            <coneGeometry args={[0.3, 0.4, 18]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.6} />
          </mesh>
          <mesh position={[0, -0.19, 0]}>
            <circleGeometry args={[0.26, 20]} />
            <meshStandardMaterial
              color={PALETTE.sun}
              emissive={PALETTE.sun}
              emissiveIntensity={1.6}
              toneMapped={false}
              side={DoubleSide}
            />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.01, 0.01, 0.6, 6]} />
            <meshStandardMaterial color={PALETTE.trim} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Workstation: desk + chair + monitor (which shows the real output)   */
/* ------------------------------------------------------------------ */

interface WorkstationProps {
  index: number;
  x: number;
  z: number;
  facing: number;
  accent: string;
  name: string;
  role: string;
  active: boolean;
  done: boolean;
  live: LiveChannel;
}

function Workstation({
  index,
  x,
  z,
  facing,
  accent,
  name,
  role,
  active,
  done,
  live,
}: WorkstationProps) {
  const dx = Math.sin(facing) * DESK_OFFSET;
  const dz = Math.cos(facing) * DESK_OFFSET;

  return (
    <>
      {/* CHAIR.
          The seat height is dictated by the rig, not by taste. A seated
          character's pelvis (the bottom of the torso capsule) lands at
          y=0.255 and the underside of its thigh at 0.275, so the seat top
          has to be 0.265. The old 0.385 was above both, which is why the
          torso pushed straight through the seat and showed up as a blob
          underneath it. */}
      <group position={[x, 0, z]} rotation={[0, facing, 0]}>
        <mesh position={[0, 0.24, -0.03]} castShadow receiveShadow>
          <boxGeometry args={[0.46, 0.05, 0.47]} />
          <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.75} />
        </mesh>
        {/* Backrest. The torso is a 0.235-radius capsule and leans forward
            0.12rad when seated, so its back surface reaches z=-0.26. The
            backrest front face sits at -0.265, flush with the rear edge of
            the seat — any nearer and the character's back extrudes through
            the panel. */}
        <mesh position={[0, 0.54, -0.29]} castShadow>
          <boxGeometry args={[0.44, 0.52, 0.05]} />
          <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.75} />
        </mesh>
        {/* pedestal + base */}
        <mesh position={[0, 0.108, 0]} castShadow>
          <cylinderGeometry args={[0.045, 0.045, 0.215, 10]} />
          <meshStandardMaterial color={PALETTE.trim} metalness={0.4} roughness={0.5} />
        </mesh>
        {[0, 1, 2, 3, 4].map((i) => {
          const a = (i / 5) * Math.PI * 2;
          return (
            <mesh
              key={i}
              position={[Math.cos(a) * 0.16, 0.03, Math.sin(a) * 0.16]}
              castShadow
            >
              <boxGeometry args={[0.26, 0.03, 0.05]} />
              <meshStandardMaterial color={PALETTE.trim} roughness={0.6} />
            </mesh>
          );
        })}
      </group>

      {/* DESK.
          The seated rig's shoulder sits at y=1.02, so its elbow hangs at
          0.72 — the top here is 0.73. The old 0.81 top meant hands typed
          *inside* the desk. Local +Z points away from the occupant (they
          stand at z=-0.6), so the monitor belongs at positive z and the
          keyboard at negative z. Those were the wrong way round, putting
          the keyboard 0.78m away — further than the arms can reach. */}
      <group position={[x + dx, 0, z + dz]} rotation={[0, facing, 0]}>
        <RoundedBox
          args={[1.4, 0.06, 0.7]}
          radius={0.03}
          smoothness={4}
          position={[0, 0.7, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={PALETTE.surface} roughness={0.6} />
        </RoundedBox>
        {[
          [-0.62, -0.3],
          [0.62, -0.3],
          [-0.62, 0.3],
          [0.62, 0.3],
        ].map(([lx, lz], i) => (
          <mesh key={i} position={[lx, 0.35, lz]} castShadow>
            <boxGeometry args={[0.05, 0.7, 0.05]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.7} />
          </mesh>
        ))}

        {/* monitor body */}
        <mesh position={[0, 0.77, 0.12]} castShadow>
          <boxGeometry args={[0.18, 0.1, 0.12]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.92, 0.12]} castShadow>
          <boxGeometry args={[0.04, 0.2, 0.04]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.5} />
        </mesh>

        {/* SCREEN — faces back toward the seated character. */}
        <group position={[0, 1.1, 0.12]} rotation={[0, Math.PI, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.68, 0.43, 0.03]} />
            <meshStandardMaterial color={PALETTE.trim} roughness={0.45} />
          </mesh>
          <mesh position={[0, 0, 0.017]}>
            <planeGeometry args={[0.62, 0.37]} />
            <meshStandardMaterial
              color={active ? accent : PALETTE.screenOff}
              emissive={active ? accent : '#000000'}
              emissiveIntensity={active ? 0.65 : 0}
              toneMapped={!active}
              roughness={0.3}
            />
          </mesh>
          {active && <MonitorText index={index} live={live} />}
        </group>

        {/* keyboard + mouse — on the near edge, within arm's reach */}
        <mesh position={[0, 0.743, -0.2]} castShadow>
          <boxGeometry args={[0.48, 0.025, 0.16]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.6} />
        </mesh>
        <mesh position={[0.32, 0.741, -0.2]} castShadow>
          <boxGeometry args={[0.08, 0.022, 0.13]} />
          <meshStandardMaterial color={PALETTE.trim} roughness={0.5} />
        </mesh>
        <mesh position={[-0.45, 0.78, -0.02]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.1, 12]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.85} />
        </mesh>

        {/* completed marker — a neat stack of paper, not a green slab */}
        {done && !active && (
          <mesh position={[0.45, 0.748, -0.1]} rotation={[0, 0.2, 0]} castShadow>
            <boxGeometry args={[0.24, 0.035, 0.3]} />
            <meshStandardMaterial color={PALETTE.paper} roughness={0.9} />
          </mesh>
        )}

        {/* nameplate */}
        <Billboard position={[0, 1.54, 0]} follow>
          <mesh>
            <planeGeometry args={[0.56, 0.15]} />
            <meshStandardMaterial color={PALETTE.paper} roughness={0.9} />
          </mesh>
          <Text position={[0, 0.022, 0.01]} fontSize={0.062} color={PALETTE.trim} anchorX="center" anchorY="middle">
            {name}
          </Text>
          <Text position={[0, -0.042, 0.01]} fontSize={0.034} color={PALETTE.surfaceDark} anchorX="center" anchorY="middle" maxWidth={0.5}>
            {role}
          </Text>
        </Billboard>
      </group>
    </>
  );
}

/**
 * MonitorText — the actual streamed output, on the actual screen.
 *
 * Troika re-lays-out text on every `sync()`, which is far too expensive to
 * run per token. This throttles to 5Hz and additionally skips when the
 * store's screen revision has not moved, so a paused stream costs nothing.
 * Only the active agent mounts this, so at most one exists at a time.
 */
function MonitorText({ index, live }: { index: number; live: LiveChannel }) {
  // drei's Text ref is a troika Text instance; it is not exported as a type.
  const textRef = useRef<{ text: string; sync: () => void } | null>(null);
  const gate = useRef({ at: 0, rev: -1 });

  useFrame((state) => {
    const node = textRef.current;
    if (!node) return;
    const now = state.clock.elapsedTime;
    if (now - gate.current.at < 0.2) return;
    if (gate.current.rev === live.screenRevision) return;
    gate.current.at = now;
    gate.current.rev = live.screenRevision;
    // Tail only — the visible window of a document being written.
    const raw = live.screen[index] ?? '';
    node.text = raw.slice(-240);
    node.sync();
  });

  return (
    <Text
      ref={textRef as never}
      position={[-0.29, -0.165, 0.019]}
      fontSize={0.021}
      lineHeight={1.32}
      color="#0b0b0c"
      fillOpacity={0.82}
      anchorX="left"
      anchorY="bottom"
      maxWidth={0.58}
      clipRect={[0, 0, 0.58, 0.35]}
    >
      {' '}
    </Text>
  );
}

/* ------------------------------------------------------------------ */
/* Folders — carrying the REAL ranked grant titles                     */
/* ------------------------------------------------------------------ */

function FoldersOnTable({ titles }: { titles: readonly string[] }) {
  // Always lay out five slots so the table reads as full even if discovery
  // returned fewer candidates.
  const slots = Array.from({ length: 5 }, (_, i) => titles[i] ?? null);

  return (
    <group position={[0, 0.78, 0]}>
      {slots.map((title, i) => {
        const x = -0.84 + i * 0.42;
        const r = (i - 2) * 0.07;
        return (
          <group key={i} position={[x, 0.02, 0]} rotation={[0, r, 0]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[0.34, 0.022, 0.44]} />
              <meshStandardMaterial color={PALETTE.paper} roughness={0.92} />
            </mesh>
            {/* tab */}
            <mesh position={[0, 0.013, -0.16]}>
              <boxGeometry args={[0.34, 0.006, 0.09]} />
              <meshStandardMaterial color={PALETTE.rug} roughness={0.85} />
            </mesh>
            <Text
              position={[0, 0.02, 0.02]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.032}
              lineHeight={1.25}
              color={PALETTE.trim}
              anchorX="center"
              anchorY="middle"
              maxWidth={0.3}
              textAlign="center"
            >
              {title ? truncate(title, 58) : `Option ${i + 1}`}
            </Text>
            <Text
              position={[0, 0.02, -0.16]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.036}
              color={PALETTE.trim}
              anchorX="center"
              anchorY="middle"
            >
              {`#${i + 1}`}
            </Text>
          </group>
        );
      })}
    </group>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/* ------------------------------------------------------------------ */
/* Set dressing                                                        */
/* ------------------------------------------------------------------ */

function FilingCabinet({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 1.1, 0.62]} />
        <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.62} metalness={0.15} />
      </mesh>
      {[0.24, 0.55, 0.86].map((y, i) => (
        <mesh key={i} position={[0, y, 0.32]}>
          <boxGeometry args={[0.34, 0.02, 0.02]} />
          <meshStandardMaterial color={PALETTE.rug} metalness={0.4} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function Plant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.19, 0.14, 0.36, 14]} />
        <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.85} />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2;
        const lean = 0.34 + (i % 3) * 0.07;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 0.12, 0.62, Math.sin(a) * 0.12]}
            rotation={[Math.sin(a) * lean, a, -Math.cos(a) * lean]}
            castShadow
          >
            <coneGeometry args={[0.1, 0.62, 5]} />
            <meshStandardMaterial color="#5f6b52" roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Wall art — tonal studies. No picture lights, no chroma.             */
/* ------------------------------------------------------------------ */

function WallArt({
  position,
  variant,
}: {
  position: [number, number, number];
  variant: 'a' | 'b' | 'c';
}) {
  const w = 1.4;
  const h = 1.0;
  return (
    <group position={position}>
      <mesh castShadow>
        <boxGeometry args={[w + 0.1, h + 0.1, 0.05]} />
        <meshStandardMaterial color={PALETTE.trim} roughness={0.55} metalness={0.15} />
      </mesh>
      <mesh position={[0, 0, 0.031]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color={PALETTE.paper} roughness={0.95} />
      </mesh>
      <group position={[0, 0, 0.033]}>
        {variant === 'a' && (
          <>
            <mesh position={[0, -0.22, 0]}>
              <planeGeometry args={[w * 0.92, h * 0.4]} />
              <meshStandardMaterial color={PALETTE.surfaceDark} roughness={0.95} />
            </mesh>
            <mesh position={[0.16, 0.2, 0.001]}>
              <circleGeometry args={[0.15, 28]} />
              <meshStandardMaterial color={PALETTE.rug} roughness={0.9} />
            </mesh>
          </>
        )}
        {variant === 'b' && (
          <>
            {[-0.42, -0.16, 0.1, 0.36].map((tx, i) => (
              <mesh key={i} position={[tx, -0.06 + (i % 2) * 0.05, 0.001]}>
                <coneGeometry args={[0.12, 0.46, 6]} />
                <meshStandardMaterial
                  color={i % 2 === 0 ? PALETTE.surfaceDark : PALETTE.floorDark}
                  roughness={0.95}
                />
              </mesh>
            ))}
          </>
        )}
        {variant === 'c' && (
          <>
            <mesh position={[-0.26, 0.13, 0.001]}>
              <circleGeometry args={[0.17, 28]} />
              <meshStandardMaterial color={PALETTE.floorDark} roughness={0.95} />
            </mesh>
            <mesh position={[0.14, -0.06, 0.002]} rotation={[0, 0, 0.4]}>
              <planeGeometry args={[0.46, 0.28]} />
              <meshStandardMaterial color={PALETTE.rug} roughness={0.95} />
            </mesh>
          </>
        )}
      </group>
    </group>
  );
}
