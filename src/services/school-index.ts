/**
 * Local NCES school index.
 *
 * The Urban Institute API cannot filter by school name (see
 * scripts/build-school-index.mjs), so name search is served from a compact
 * index built ahead of time and held in memory. Loading is lazy and happens
 * once per server process.
 */
import { readFileSync } from 'fs';
import path from 'path';
import type { NCESSchool } from './nces-api';

interface IndexFile {
  source: string;
  endpoint: string;
  year: number;
  builtAt: string;
  fields: string[];
  rows: (string | number | null)[][];
}

/** Tuple positions, mirrored from scripts/build-school-index.mjs. */
const F = {
  ncessch: 0,
  name: 1,
  lea: 2,
  city: 3,
  state: 4,
  zip: 5,
  enrollment: 6,
  lowGrade: 7,
  highGrade: 8,
  charter: 9,
  type: 10,
  level: 11,
  status: 12,
  titleI: 13,
  frl: 14,
  phone: 15,
} as const;

interface Entry {
  row: (string | number | null)[];
  haystack: string;
  name: string;
  enrollment: number;
}

let entries: Entry[] | null = null;
let meta: { year: number; source: string; builtAt: string } | null = null;
let loadFailed = false;

/**
 * School statuses that mean "not operating this year". Everything else
 * (open, new, added, reopened, changed agency) belongs in the picker.
 */
const NOT_OPERATING = new Set([2, 6, 7]);

function load(): Entry[] | null {
  if (entries) return entries;
  if (loadFailed) return null;
  try {
    const file = path.join(process.cwd(), 'data', 'schools-index.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as IndexFile;
    meta = { year: parsed.year, source: parsed.source, builtAt: parsed.builtAt };
    entries = parsed.rows
      .filter((row) => {
        const status = row[F.status];
        return typeof status !== 'number' || !NOT_OPERATING.has(status);
      })
      .map((row) => {
        const name = String(row[F.name] ?? '');
        return {
          row,
          name,
          enrollment: Number(row[F.enrollment] ?? 0),
          haystack: `${name} ${row[F.city] ?? ''} ${row[F.lea] ?? ''} ${row[F.state] ?? ''}`
            .toLowerCase()
            .replace(/\s+/g, ' '),
        };
      });
    return entries;
  } catch (error) {
    // No index built yet. The caller falls back to the curated database and
    // says so, rather than pretending the federal directory is available.
    console.error('[school-index] index unavailable, falling back to curated database:', error);
    loadFailed = true;
    return null;
  }
}

export function isSchoolIndexAvailable(): boolean {
  return load() !== null;
}

/**
 * How many schools the picker can actually find.
 *
 * This is deliberately derived from the same filtered list that serves
 * search, not from `rows.length` and not from a constant typed into the
 * UI. The file ships more rows than are searchable — closed and inactive
 * schools are dropped by `NOT_OPERATING` — so the two numbers differ by
 * about two thousand, and any hardcoded figure would start drifting the
 * next time the index is rebuilt.
 *
 * Returns `null` when no index is built, so callers can say nothing
 * rather than claim a number.
 */
export function schoolIndexCount(): number | null {
  return load()?.length ?? null;
}

export function schoolIndexMeta(): { year: number; source: string; builtAt: string } | null {
  load();
  return meta;
}

function decodeGrade(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  if (n === -1) return 'PK';
  if (n === 0) return 'K';
  if (n >= 1 && n <= 13) return String(n);
  return null;
}

function decodeType(row: (string | number | null)[]): NCESSchool['type'] {
  return Number(row[F.charter]) === 1 ? 'Charter' : 'Public';
}

function toSchool(row: (string | number | null)[]): NCESSchool {
  const low = decodeGrade(row[F.lowGrade]);
  const high = decodeGrade(row[F.highGrade]);
  const enrollment = Number(row[F.enrollment] ?? 0);
  const frl = row[F.frl] === null ? null : Number(row[F.frl]);
  const titleIStatus = row[F.titleI] === null ? null : Number(row[F.titleI]);

  return {
    id: String(row[F.ncessch] ?? ''),
    name: String(row[F.name] ?? 'Unknown School'),
    district: String(row[F.lea] ?? 'Unknown District'),
    city: String(row[F.city] ?? ''),
    state: String(row[F.state] ?? ''),
    zip: String(row[F.zip] ?? ''),
    students: enrollment,
    grades: low && high ? (low === high ? low : `${low}-${high}`) : '',
    type: decodeType(row),
    demographics: {
      // Only the free/reduced-price lunch share is derivable from the CCD
      // directory. Race and English-learner counts live in separate
      // endpoints, so they are reported as unknown instead of being computed
      // from absent fields - the previous code divided by a missing "white"
      // count and produced a hard-coded 100% minority share for every school.
      freeReducedLunch:
        frl !== null && enrollment > 0
          ? Math.min(100, Math.round((frl / enrollment) * 100))
          : null,
      minorityEnrollment: null,
      englishLearners: null,
    },
    programs: {
      // The directory endpoint carries no program inventory. `false` means
      // "the federal record is silent", rendered downstream as "Not
      // documented" rather than as a denial.
      stem: false,
      cte: false,
      specialEd: Number(row[F.type]) === 2,
      titleI: titleIStatus !== null && titleIStatus >= 1 && titleIStatus <= 5,
    },
    contact: {
      phone: String(row[F.phone] ?? ''),
    },
    ncesschoolid: String(row[F.ncessch] ?? ''),
    level: String(row[F.level] ?? ''),
    status: 'Open',
  };
}

/**
 * Rank a school against the query. Higher is better, 0 means no match.
 * Every query token has to appear somewhere, so "lincoln brooklyn" narrows
 * rather than widening.
 */
function score(entry: Entry, tokens: string[], query: string): number {
  for (const token of tokens) {
    if (!entry.haystack.includes(token)) return 0;
  }
  const name = entry.name.toLowerCase();
  let points = 1;
  if (name === query) points = 100;
  else if (name.startsWith(query)) points = 60;
  else if (name.includes(query)) points = 40;
  else if (tokens.every((t) => name.includes(t))) points = 25;
  else points = 10;
  // Larger schools first inside a score band; enrollment is a stable, honest
  // tiebreak and matches what a grant writer is usually looking for.
  return points * 1_000_000 + entry.enrollment;
}

export function searchSchoolIndex(
  query: string,
  state?: string,
  limit = 50,
): { schools: NCESSchool[]; totalMatches: number } | null {
  const all = load();
  if (!all) return null;

  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return { schools: [], totalMatches: 0 };

  const wanted = state?.toUpperCase();
  const matches: { entry: Entry; score: number }[] = [];
  for (const entry of all) {
    if (wanted && entry.row[F.state] !== wanted) continue;
    const value = score(entry, tokens, normalized);
    if (value > 0) matches.push({ entry, score: value });
  }

  matches.sort((a, b) => b.score - a.score);
  return {
    schools: matches.slice(0, limit).map((m) => toSchool(m.entry.row)),
    totalMatches: matches.length,
  };
}

export function getSchoolFromIndex(ncesId: string): NCESSchool | null {
  const all = load();
  if (!all) return null;
  const found = all.find((entry) => entry.row[F.ncessch] === ncesId);
  return found ? toSchool(found.row) : null;
}
