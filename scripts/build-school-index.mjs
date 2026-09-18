/**
 * Builds the local NCES school search index.
 *
 * Why this exists: the Urban Institute Education Data Portal exposes the full
 * NCES Common Core of Data school directory, but its only filterable fields
 * are the ones flagged FILTER in the documentation - `state_location`, `fips`,
 * `ncessch`, `leaid` and friends. `school_name` is NOT filterable: passing it
 * is silently ignored and the API answers with the whole directory in
 * alphabetical order. A name search therefore cannot be served by the remote
 * API at all, and a page of 10,000 records takes ~80s, which rules out
 * querying it live behind a typeahead.
 *
 * So we download the directory once and keep a compact local index. Records are
 * stored as positional tuples rather than objects: the field names would
 * otherwise account for roughly two thirds of the file.
 *
 * Usage: node scripts/build-school-index.mjs [year]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const YEAR = process.argv[2] ?? '2024';
const PER_PAGE = 10000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data', `schools-index.json`);

// Cloudflare fronts educationdata.urban.org and rejects requests whose
// User-Agent is not browser-like with a 403 HTML challenge page. Node's
// default `undici` agent is one of those. This is the whole reason the live
// school search was failing.
const HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 smart-grant-request/1.0',
};

/** Fields kept per school, in tuple order. Mirrored in src/services/school-index.ts. */
const FIELDS = [
  'ncessch',
  'school_name',
  'lea_name',
  'city_location',
  'state_location',
  'zip_location',
  'enrollment',
  'lowest_grade_offered',
  'highest_grade_offered',
  'charter',
  'school_type',
  'school_level',
  'school_status',
  'title_i_status',
  'free_or_reduced_price_lunch',
  'phone',
];

/** The API uses negative sentinels for missing/suppressed values. */
function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value < 0 ? null : value;
  const text = String(value).trim();
  if (!text || text === '-1' || text === '-2' || text === '-3') return null;
  return text;
}

async function fetchPage(page, attempt = 1) {
  const url =
    `https://educationdata.urban.org/api/v1/schools/ccd/directory/${YEAR}/` +
    `?per_page=${PER_PAGE}&page=${page}`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 4) throw error;
    const wait = 2000 * attempt;
    console.warn(`  page ${page} failed (${error.message}); retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchPage(page, attempt + 1);
  }
}

async function main() {
  console.log(`Building NCES school index for ${YEAR}...`);
  const rows = [];
  let page = 1;
  let total = null;

  for (;;) {
    const startedAt = Date.now();
    const body = await fetchPage(page);
    total ??= body.count;
    for (const record of body.results ?? []) {
      rows.push(FIELDS.map((field) => clean(record[field])));
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`  page ${page}: ${rows.length}/${total} records (${seconds}s)`);
    if (!body.next) break;
    page++;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      source: 'NCES Common Core of Data via Urban Institute Education Data Portal',
      endpoint: `https://educationdata.urban.org/api/v1/schools/ccd/directory/${YEAR}/`,
      year: Number(YEAR),
      builtAt: new Date().toISOString(),
      // Travels with the data so a copy of this file is never separated from the
      // attribution its licence requires. See NOTICE.md.
      license: 'ODC-By-1.0',
      licenseUrl: 'https://opendatacommons.org/licenses/by/1-0/',
      attribution:
        `Common Core of Data school directory (${YEAR}), Education Data Portal, ` +
        'Urban Institute, https://educationdata.urban.org/documentation/, ' +
        'made available under the ODC Attribution License.',
      fields: FIELDS,
      rows,
    }),
    'utf8',
  );
  console.log(`Wrote ${rows.length} schools to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
