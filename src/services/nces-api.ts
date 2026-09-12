/**
 * NCES (National Center for Education Statistics) API Integration
 * 
 * Real-time school data from the U.S. Department of Education
 * Database: ~130,000 public schools, ~34,000 private schools
 * 
 * Data Source: NCES Common Core of Data (CCD)
 * API: https://nces.ed.gov/ccd/
 */

import { schoolIndexMeta, searchSchoolIndex, getSchoolFromIndex } from './school-index'

export interface NCESSchool {
  id: string
  name: string
  district: string
  city: string
  state: string
  zip: string
  students: number
  grades: string
  type: 'Public' | 'Charter' | 'Private'
  /**
   * `null` means the federal record does not carry the figure. It is not the
   * same as zero and must never be rendered as a percentage.
   */
  demographics?: {
    freeReducedLunch: number | null
    minorityEnrollment: number | null
    englishLearners: number | null
  }
  programs?: {
    stem: boolean
    cte: boolean
    specialEd: boolean
    titleI: boolean
  }
  contact: {
    phone: string
    website?: string
  }
  // NCES specific fields
  ncesschoolid?: string
  leaid?: string // Local Education Agency ID
  level?: string // Elementary, Middle, High, Other
  status?: string // Open, Closed, etc.
}

/**
 * Search schools using external APIs (NCES-style data)
 * Falls back to local database if API unavailable
 */
export async function searchSchoolsNCES(query: string, state?: string, limit: number = 50): Promise<{
  success: boolean
  schools: NCESSchool[]
  count: number
  totalMatches?: number
  source: 'nces' | 'local' | 'hybrid'
  hint?: string
}> {
  // Name search is served from the local NCES index. The remote API exposes no
  // name filter at all - `school_name` is accepted and silently ignored, so
  // the previous implementation was returning the alphabetically first schools
  // in the country for every query - and a single page of it takes over a
  // minute, which no typeahead can wait for.
  const indexed = searchSchoolIndex(query, state, limit)
  if (indexed) {
    const meta = schoolIndexMeta()
    return {
      success: true,
      schools: indexed.schools,
      count: indexed.schools.length,
      totalMatches: indexed.totalMatches,
      source: 'nces',
      hint: meta
        ? `NCES Common Core of Data ${meta.year} directory (${indexed.totalMatches.toLocaleString()} matches).`
        : undefined,
    }
  }

  return {
    success: true,
    schools: [],
    count: 0,
    source: 'local',
    hint: 'NCES index not built. Run: npm run build:school-index',
  }
}

/**
 * Education Data Portal request headers.
 *
 * Cloudflare fronts educationdata.urban.org and answers requests with a
 * non-browser User-Agent - which is what Node's fetch sends by default - with
 * a 403 challenge page. Identifying ourselves properly is what makes the
 * endpoint reachable at all.
 */
const EDU_API_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 smart-grant-request/1.0',
}

const EDU_DIRECTORY_YEAR = 2024

/**
 * Transform NCES API data to our school format
 */
function transformNCESData(ncesSchool: any): NCESSchool {
  return {
    id: ncesSchool.ncessch || `nces-${ncesSchool.school_id}`,
    name: ncesSchool.school_name || 'Unknown School',
    district: ncesSchool.lea_name || 'Unknown District',
    city: ncesSchool.city_location || 'Unknown',
    state: ncesSchool.state_location || 'XX',
    zip: ncesSchool.zip_location || '00000',
    students: ncesSchool.enrollment || 0,
    grades: determineGrades(ncesSchool),
    type: determineSchoolType(ncesSchool),
    demographics: {
      freeReducedLunch: calculateFreeReducedLunch(ncesSchool),
      // The CCD directory endpoint returns neither a race breakdown nor an
      // English-learner count; those live in separate enrollment endpoints.
      // Deriving them here divided by fields that are always undefined and
      // produced a 100% minority share and a 0% English-learner share for
      // every school in the country.
      minorityEnrollment: null,
      englishLearners: null,
    },
    programs: {
      // The CCD directory endpoint carries no program inventory. `false`
      // here means "the federal record is silent", and every downstream
      // consumer renders it as "Not documented" rather than as an absence.
      // Asserting `specialEd: true` because most schools have one was a
      // fabrication in a pipeline whose whole premise is that agents never
      // invent facts about the applicant.
      stem: false,
      cte: false,
      specialEd: ncesSchool.school_type === 2,
      titleI: ncesSchool.title_i_status >= 1 && ncesSchool.title_i_status <= 5,
    },
    contact: {
      phone: ncesSchool.phone || '',
    },
    ncesschoolid: ncesSchool.ncessch,
    leaid: ncesSchool.leaid,
    level: ncesSchool.school_level,
    status: ncesSchool.school_status === 2 ? 'Closed' : 'Open',
  }
}

/** CCD encodes grades numerically: -1 pre-K, 0 kindergarten, 1-13 by grade. */
function decodeGrade(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (Number.isNaN(n)) return null
  if (n === -1) return 'PK'
  if (n === 0) return 'K'
  if (n >= 1 && n <= 13) return String(n)
  return null
}

function determineGrades(school: any): string {
  const low = decodeGrade(school.lowest_grade_offered)
  const high = decodeGrade(school.highest_grade_offered)
  if (!low || !high) return ''
  return low === high ? low : `${low}-${high}`
}

function determineSchoolType(school: any): 'Public' | 'Charter' | 'Private' {
  return school.charter === 1 ? 'Charter' : 'Public'
}

/** `null` when the school does not report lunch eligibility. */
function calculateFreeReducedLunch(school: any): number | null {
  const total = Number(school.enrollment)
  const frl = Number(school.free_or_reduced_price_lunch)
  if (!Number.isFinite(total) || total <= 0) return null
  if (!Number.isFinite(frl) || frl < 0) return null
  return Math.min(100, Math.round((frl / total) * 100))
}

/**
 * Alternative: Search using SchoolDigger API (requires API key)
 * https://www.schooldigger.com/api
 */
export async function searchSchoolDigger(query: string, state?: string): Promise<NCESSchool[]> {
  // Requires API key - add to .env.local:
  // SCHOOLDIGGER_API_KEY=your_key_here
  
  const apiKey = process.env.SCHOOLDIGGER_API_KEY
  if (!apiKey) {
    console.warn('SchoolDigger API key not configured')
    return []
  }
  
  try {
    const baseURL = 'https://api.schooldigger.com/v2.0/schools'
    const params = new URLSearchParams({
      st: state || 'CA',
      q: query,
      appID: 'your_app_id',
      appKey: apiKey,
    })
    
    const response = await fetch(`${baseURL}?${params.toString()}`)
    const data = await response.json()
    
    return data.schoolList?.map((school: any) => ({
      id: school.schoolId,
      name: school.schoolName,
      district: school.districtName,
      city: school.city,
      state: school.state,
      zip: school.zip,
      students: school.enrollment || 0,
      grades: `${school.lowGrade}-${school.highGrade}`,
      type: 'Public',
      contact: {
        phone: school.phone || '',
        website: school.url,
      },
    })) || []
  } catch (error) {
    console.error('SchoolDigger API error:', error)
    return []
  }
}

/**
 * Get detailed school information by NCES ID
 */
export async function getSchoolByNCESId(ncesschid: string): Promise<NCESSchool | null> {
  const indexed = getSchoolFromIndex(ncesschid)
  if (indexed) return indexed

  try {
    // `ncessch` is one of the few fields the portal actually filters on, so a
    // single-record lookup is fast enough to do live.
    const response = await fetch(
      `https://educationdata.urban.org/api/v1/schools/ccd/directory/${EDU_DIRECTORY_YEAR}/?ncessch=${encodeURIComponent(ncesschid)}`,
      { headers: EDU_API_HEADERS },
    )

    if (!response.ok) return null

    const data = await response.json()
    if (data.results && data.results.length > 0) {
      return transformNCESData(data.results[0])
    }

    return null
  } catch (error) {
    console.error('Get school by ID error:', error)
    return null
  }
}
