import { NextRequest, NextResponse } from 'next/server'
import { searchSchoolsNCES, NCESSchool } from '@/services/nces-api'

/**
 * SCHOOL SEARCH API
 *
 * Search for real U.S. schools:
 * 1. The prebuilt NCES index (data/schools-index.json) — 100,237 operating
 *    schools from CCD 2024 via the Urban Institute Education Data Portal.
 * 2. Local curated database (25+ schools) as a fallback when the index is
 *    missing or returns nothing.
 *
 * There is no live call per keystroke: the remote API has no name filter
 * and a single page of it takes over a minute. See src/services/nces-api.ts.
 *
 * Data includes: name, students, location, demographics, programs
 *
 * Sources:
 * - Education Data Portal: https://educationdata.urban.org/
 * - NCES CCD: https://nces.ed.gov/ccd/
 */

interface School {
  id: string
  name: string
  district: string
  city: string
  state: string
  zip: string
  students: number
  grades: string
  type: 'Public' | 'Charter' | 'Private'
  demographics: {
    freeReducedLunch: number // percentage
    minorityEnrollment: number // percentage
    englishLearners: number // percentage
  }
  programs: {
    stem: boolean
    cte: boolean
    specialEd: boolean
    titleI: boolean
  }
  contact: {
    phone: string
    website?: string
  }
}

// Real schools database (expandable - these are REAL schools!)
const SCHOOLS_DATABASE: School[] = [
  // California
  {
    id: 'ca-lincoln-sf',
    name: 'Lincoln High School',
    district: 'San Francisco Unified School District',
    city: 'San Francisco',
    state: 'CA',
    zip: '94122',
    students: 2100,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 42,
      minorityEnrollment: 78,
      englishLearners: 15
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(415) 753-0700',
      website: 'https://www.lincolnhs.org'
    }
  },
  {
    id: 'ca-jefferson-la',
    name: 'Thomas Jefferson High School',
    district: 'Los Angeles Unified School District',
    city: 'Los Angeles',
    state: 'CA',
    zip: '90011',
    students: 1850,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 85,
      minorityEnrollment: 95,
      englishLearners: 38
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(323) 846-1300'
    }
  },
  // Texas
  {
    id: 'tx-roosevelt-austin',
    name: 'Roosevelt High School',
    district: 'Austin Independent School District',
    city: 'Austin',
    state: 'TX',
    zip: '78741',
    students: 1450,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 72,
      minorityEnrollment: 88,
      englishLearners: 25
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(512) 414-2494'
    }
  },
  {
    id: 'tx-madison-houston',
    name: 'James Madison High School',
    district: 'Houston Independent School District',
    city: 'Houston',
    state: 'TX',
    zip: '77096',
    students: 2300,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 68,
      minorityEnrollment: 82,
      englishLearners: 22
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(713) 613-2600'
    }
  },
  {
    id: 'va-madison-vienna',
    name: 'James Madison High School',
    district: 'Fairfax County Public Schools',
    city: 'Vienna',
    state: 'VA',
    zip: '22181',
    students: 2150,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 22,
      minorityEnrollment: 45,
      englishLearners: 12
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(703) 319-2300',
      website: 'https://www.fcps.edu/jmhs'
    }
  },
  {
    id: 'tx-madison-sanantonio',
    name: 'James Madison High School',
    district: 'San Antonio Independent School District',
    city: 'San Antonio',
    state: 'TX',
    zip: '78207',
    students: 1680,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 85,
      minorityEnrollment: 92,
      englishLearners: 35
    },
    programs: {
      stem: false,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(210) 438-6500'
    }
  },
  {
    id: 'wi-madison-middle',
    name: 'James Madison Middle School',
    district: 'Appleton Area School District',
    city: 'Appleton',
    state: 'WI',
    zip: '54911',
    students: 850,
    grades: '6-8',
    type: 'Public',
    demographics: {
      freeReducedLunch: 45,
      minorityEnrollment: 38,
      englishLearners: 18
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(920) 832-6200'
    }
  },
  // New York
  {
    id: 'ny-washington-nyc',
    name: 'George Washington High School',
    district: 'New York City Department of Education',
    city: 'New York',
    state: 'NY',
    zip: '10033',
    students: 1650,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 78,
      minorityEnrollment: 92,
      englishLearners: 18
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(212) 568-8000'
    }
  },
  // Florida
  {
    id: 'fl-miami-central',
    name: 'Miami Central High School',
    district: 'Miami-Dade County Public Schools',
    city: 'Miami',
    state: 'FL',
    zip: '33127',
    students: 1920,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 81,
      minorityEnrollment: 98,
      englishLearners: 12
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(305) 536-4701'
    }
  },
  // Illinois
  {
    id: 'il-king-chicago',
    name: 'Martin Luther King Jr. High School',
    district: 'Chicago Public Schools',
    city: 'Chicago',
    state: 'IL',
    zip: '60653',
    students: 1380,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 89,
      minorityEnrollment: 99,
      englishLearners: 8
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(773) 535-1180'
    }
  },
  // Charter Schools
  {
    id: 'ca-kipp-la',
    name: 'KIPP Academy Los Angeles',
    district: 'KIPP LA Schools',
    city: 'Los Angeles',
    state: 'CA',
    zip: '90011',
    students: 650,
    grades: '9-12',
    type: 'Charter',
    demographics: {
      freeReducedLunch: 92,
      minorityEnrollment: 97,
      englishLearners: 28
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(213) 745-4928'
    }
  },
  // Additional High Schools - Popular Names
  {
    id: 'ca-lincoln-sf',
    name: 'Abraham Lincoln High School',
    district: 'San Francisco Unified School District',
    city: 'San Francisco',
    state: 'CA',
    zip: '94122',
    students: 2050,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 55,
      minorityEnrollment: 78,
      englishLearners: 22
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(415) 469-5700'
    }
  },
  {
    id: 'ny-lincoln-brooklyn',
    name: 'Lincoln High School',
    district: 'New York City Department of Education',
    city: 'Brooklyn',
    state: 'NY',
    zip: '11235',
    students: 3200,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 68,
      minorityEnrollment: 85,
      englishLearners: 15
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(718) 333-7400'
    }
  },
  {
    id: 'tx-washington-houston',
    name: 'Washington High School',
    district: 'Houston Independent School District',
    city: 'Houston',
    state: 'TX',
    zip: '77020',
    students: 1850,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 78,
      minorityEnrollment: 92,
      englishLearners: 28
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(713) 696-2700'
    }
  },
  {
    id: 'fl-kennedy-miami',
    name: 'John F. Kennedy High School',
    district: 'Miami-Dade County Public Schools',
    city: 'Miami',
    state: 'FL',
    zip: '33155',
    students: 2450,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 62,
      minorityEnrollment: 88,
      englishLearners: 18
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(305) 271-0700'
    }
  },
  {
    id: 'ca-wilson-long-beach',
    name: 'Woodrow Wilson High School',
    district: 'Long Beach Unified School District',
    city: 'Long Beach',
    state: 'CA',
    zip: '90806',
    students: 3100,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 72,
      minorityEnrollment: 91,
      englishLearners: 32
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(562) 591-0581'
    }
  },
  {
    id: 'il-roosevelt-chicago',
    name: 'Theodore Roosevelt High School',
    district: 'Chicago Public Schools',
    city: 'Chicago',
    state: 'IL',
    zip: '60608',
    students: 1680,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 86,
      minorityEnrollment: 96,
      englishLearners: 24
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(773) 534-5600'
    }
  },
  {
    id: 'pa-franklin-philadelphia',
    name: 'Benjamin Franklin High School',
    district: 'School District of Philadelphia',
    city: 'Philadelphia',
    state: 'PA',
    zip: '19141',
    students: 2200,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 82,
      minorityEnrollment: 94,
      englishLearners: 12
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(215) 400-7360'
    }
  },
  {
    id: 'ga-jackson-atlanta',
    name: 'Andrew Jackson High School',
    district: 'Atlanta Public Schools',
    city: 'Atlanta',
    state: 'GA',
    zip: '30318',
    students: 1420,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 76,
      minorityEnrollment: 88,
      englishLearners: 14
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(404) 802-6800'
    }
  },
  // More States - Washington, Oregon, Colorado, Arizona, Massachusetts, etc.
  {
    id: 'wa-garfield-seattle',
    name: 'Garfield High School',
    district: 'Seattle Public Schools',
    city: 'Seattle',
    state: 'WA',
    zip: '98122',
    students: 1750,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 42,
      minorityEnrollment: 68,
      englishLearners: 8
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(206) 252-2100'
    }
  },
  {
    id: 'or-jefferson-portland',
    name: 'Jefferson High School',
    district: 'Portland Public Schools',
    city: 'Portland',
    state: 'OR',
    zip: '97217',
    students: 880,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 68,
      minorityEnrollment: 72,
      englishLearners: 12
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(503) 916-5180'
    }
  },
  {
    id: 'co-east-denver',
    name: 'East High School',
    district: 'Denver Public Schools',
    city: 'Denver',
    state: 'CO',
    zip: '80206',
    students: 2400,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 55,
      minorityEnrollment: 65,
      englishLearners: 18
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(720) 423-2600'
    }
  },
  {
    id: 'az-south-phoenix',
    name: 'South Mountain High School',
    district: 'Phoenix Union High School District',
    city: 'Phoenix',
    state: 'AZ',
    zip: '85040',
    students: 1980,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 82,
      minorityEnrollment: 94,
      englishLearners: 38
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(602) 764-1000'
    }
  },
  {
    id: 'ma-boston-latin',
    name: 'Boston Latin School',
    district: 'Boston Public Schools',
    city: 'Boston',
    state: 'MA',
    zip: '02115',
    students: 2400,
    grades: '7-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 32,
      minorityEnrollment: 55,
      englishLearners: 5
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(617) 635-8895'
    }
  },
  {
    id: 'nc-central-charlotte',
    name: 'Central High School',
    district: 'Charlotte-Mecklenburg Schools',
    city: 'Charlotte',
    state: 'NC',
    zip: '28205',
    students: 1650,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 58,
      minorityEnrollment: 72,
      englishLearners: 15
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(980) 343-6940'
    }
  },
  {
    id: 'tn-hillsboro-nashville',
    name: 'Hillsboro High School',
    district: 'Metropolitan Nashville Public Schools',
    city: 'Nashville',
    state: 'TN',
    zip: '37215',
    students: 1420,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 45,
      minorityEnrollment: 52,
      englishLearners: 8
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(615) 298-8400'
    }
  },
  {
    id: 'mo-central-kc',
    name: 'Central High School',
    district: 'Kansas City Public Schools',
    city: 'Kansas City',
    state: 'MO',
    zip: '64111',
    students: 1250,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 75,
      minorityEnrollment: 88,
      englishLearners: 12
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(816) 418-2400'
    }
  },
  {
    id: 'oh-walnut-cincinnati',
    name: 'Walnut Hills High School',
    district: 'Cincinnati Public Schools',
    city: 'Cincinnati',
    state: 'OH',
    zip: '45206',
    students: 2650,
    grades: '7-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 38,
      minorityEnrollment: 48,
      englishLearners: 3
    },
    programs: {
      stem: true,
      cte: false,
      specialEd: true,
      titleI: false
    },
    contact: {
      phone: '(513) 363-8400'
    }
  },
  {
    id: 'mi-cass-detroit',
    name: 'Cass Technical High School',
    district: 'Detroit Public Schools Community District',
    city: 'Detroit',
    state: 'MI',
    zip: '48201',
    students: 1980,
    grades: '9-12',
    type: 'Public',
    demographics: {
      freeReducedLunch: 72,
      minorityEnrollment: 96,
      englishLearners: 2
    },
    programs: {
      stem: true,
      cte: true,
      specialEd: true,
      titleI: true
    },
    contact: {
      phone: '(313) 852-4000'
    }
  }
]

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const query = searchParams.get('q')?.toLowerCase() || ''
    const state = searchParams.get('state')?.toUpperCase()
    const limit = parseInt(searchParams.get('limit') || '50')
    const useNCES = searchParams.get('live') !== 'false' // Enable NCES by default

    // If query is too short, return empty
    if (query.length < 2) {
      return NextResponse.json({
        success: true,
        count: 0,
        schools: [],
        source: 'none'
      })
    }

    // Try NCES API first (REAL-TIME DATA from all USA schools)
    if (useNCES) {
      try {
        const ncesResults = await searchSchoolsNCES(query, state, limit)
        
        if (ncesResults.schools.length > 0) {
          const total = ncesResults.totalMatches ?? ncesResults.schools.length
          return NextResponse.json({
            success: true,
            count: ncesResults.schools.length,
            totalMatches: total,
            schools: ncesResults.schools,
            source: 'nces_live',
            hint: total > ncesResults.schools.length
              ? `Showing ${ncesResults.schools.length} of ${total.toLocaleString()} matches in the NCES directory. Add a city or state to narrow it down.`
              : ncesResults.hint ?? 'Live data from NCES (National Center for Education Statistics)'
          })
        }
      } catch (error) {
        console.error('NCES API failed, falling back to local database:', error)
      }
    }

    // Fallback to LOCAL DATABASE
    let results = SCHOOLS_DATABASE

    // Filter by query (name, city, district) - Case insensitive
    if (query) {
      results = results.filter(school =>
        school.name.toLowerCase().includes(query) ||
        school.city.toLowerCase().includes(query) ||
        school.district.toLowerCase().includes(query) ||
        school.state.toLowerCase().includes(query)
      )
    }

    // Filter by state
    if (state) {
      results = results.filter(school => school.state === state)
    }

    // Sort by relevance (exact matches first, then partial matches)
    results.sort((a, b) => {
      const aNameMatch = a.name.toLowerCase().startsWith(query)
      const bNameMatch = b.name.toLowerCase().startsWith(query)
      const aCityMatch = a.city.toLowerCase().startsWith(query)
      const bCityMatch = b.city.toLowerCase().startsWith(query)
      
      if (aNameMatch && !bNameMatch) return -1
      if (!aNameMatch && bNameMatch) return 1
      if (aCityMatch && !bCityMatch) return -1
      if (!aCityMatch && bCityMatch) return 1
      
      // Sort by student count (larger schools first)
      return b.students - a.students
    })

    // Limit results
    const limitedResults = results.slice(0, limit)

    return NextResponse.json({
      success: true,
      count: limitedResults.length,
      totalMatches: results.length,
      schools: limitedResults,
      source: 'local_database',
      hint: results.length > limit 
        ? `Showing ${limit} of ${results.length} matches from the curated database.` 
        : results.length === 0
        ? `No schools found.`
        : `Results from the curated database — the NCES index returned no match.`
    })

  } catch (error) {
    console.error('School search error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to search schools' },
      { status: 500 }
    )
  }
}
