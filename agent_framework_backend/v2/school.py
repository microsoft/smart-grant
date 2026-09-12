"""
Perfil da escola usado por todos os agentes do v2.

Fica aqui, e nao no pacote de prompts da v1, porque e a fonte de verdade sobre
a escola: define a forma do dado e a unica formatacao autorizada dele. A regra
central e anti-fabricacao — um campo ausente no registro federal e declarado
como ausente, nunca estimado, e contagens absolutas sao derivadas por
aritmetica da matricula informada, com a derivacao dita em voz alta.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SchoolData:
    """School data structure matching the TypeScript interface."""

    id: str
    name: str
    district: str
    city: str
    state: str
    zip: str
    students: int
    grades: str
    type: str  # 'Public' | 'Charter' | 'Private'
    demographics: dict  # freeReducedLunch, minorityEnrollment, englishLearners
    programs: dict  # stem, cte, specialEd, titleI
    contact: dict  # phone, website


def format_school_context(school_data: SchoolData | None) -> str:
    """Format school data for agent context - FULL DATA, not abbreviated.

    Percentages alone produce vague prose ("a substantial share of students").
    Reviewers respond to counts. Every absolute figure below is *derived by
    arithmetic* from the supplied enrolment and percentage - nothing is
    invented - and the derivation is stated so the agents can cite it
    honestly ("approximately 2,232 of 3,100 students").
    """
    if not school_data:
        return "ERROR: School data is required - do not fabricate any school information"

    # A missing value means the federal record is silent about it. It is not
    # zero, and it must not be presented as a percentage.
    free_lunch = school_data.demographics.get("freeReducedLunch")
    minority = school_data.demographics.get("minorityEnrollment")
    ell = school_data.demographics.get("englishLearners")

    enrolled = school_data.students or 0

    def _count(pct) -> str:
        try:
            pct_f = float(pct)
        except (TypeError, ValueError):
            return "not derivable"
        if not enrolled:
            return "not derivable (enrolment unknown)"
        return f"~{round(enrolled * pct_f / 100.0):,} students"

    def _pct_line(label: str, pct) -> str:
        if pct is None:
            return f"- {label:<34}not reported in the federal record - do not estimate it"
        return f"- {label:<34}{pct}% = {_count(pct)}"

    # Determine economic characterization based on actual data
    if free_lunch is None:
        economic_note = (
            "Lunch-eligibility share not on record - do NOT characterise the "
            "community's income level"
        )
    elif free_lunch >= 70:
        economic_note = "High-need school - Title I eligible"
    elif free_lunch >= 50:
        economic_note = "Moderate-need school"
    elif free_lunch >= 30:
        economic_note = "Mixed-income school community"
    else:
        economic_note = "Higher-income school community - do NOT describe as underserved"

    # Grade band shapes which interventions are even plausible. Deriving it
    # keeps the agents from proposing elementary literacy centres to a high
    # school, or dual-enrolment pathways to a K-5 campus.
    grades = (school_data.grades or "").upper()
    if any(tok in grades for tok in ("9", "10", "11", "12")):
        band = (
            "Secondary (high school) - career pathways, dual enrolment, capstone "
            "and industry credentials are in scope"
        )
    elif any(tok in grades for tok in ("6", "7", "8")):
        band = (
            "Middle grades - exploratory courses, career awareness and "
            "acceleration are in scope"
        )
    else:
        band = (
            "Elementary - foundational literacy/numeracy, enrichment and family "
            "engagement are in scope"
        )

    programs = school_data.programs or {}
    program_lines = [
        f"- STEM program on campus: {'Yes' if programs.get('stem') else 'Not documented'}",
        f"- CTE program on campus: {'Yes' if programs.get('cte') else 'Not documented'}",
        f"- Special Education services: {'Yes' if programs.get('specialEd') else 'Not documented'}",
        f"- Title I: {'Yes' if programs.get('titleI') else 'Not documented'}",
    ]

    contact = school_data.contact or {}
    website = contact.get("website") or ""
    website_line = f"Website: {website}" if website else "Website: not on record"

    return f"""
=== SCHOOL PROFILE - USE ONLY THIS DATA ===
SCHOOL NAME: {school_data.name}
District (LEA): {school_data.district}
Location: {school_data.city}, {school_data.state} {school_data.zip}
Total enrolment: {enrolled:,} students
Grades served: {school_data.grades}
Grade band: {band}
Governance: {school_data.type}
{website_line}

DEMOGRAPHICS - PERCENTAGES ARE ON RECORD; COUNTS ARE ARITHMETIC FROM ENROLMENT.
Cite either form, but never round a percentage to a different number.
{_pct_line("Free/Reduced-Price Lunch eligible:", free_lunch)}
{_pct_line("Minority enrolment:", minority)}
{_pct_line("English Learners:", ell)}

ECONOMIC CHARACTERIZATION: {economic_note}

PROGRAMS ON RECORD:
{chr(10).join(program_lines)}

HOW TO USE THIS PROFILE
- Lead with counts, not adjectives. "2,232 of 3,100 students qualify for
  free or reduced-price lunch" beats "many students face economic hardship".
- Scale every deliverable to this enrolment. A project that reaches 300
  students at a 3,100-student school must say so and justify the phasing.
- "Not documented" means the record is silent, NOT that the program is
  absent. Write "the record does not document a CTE program", never "the
  school has no CTE program".
- Derived counts are approximations of the supplied percentage. Prefix them
  with "approximately" the first time each appears.

ABSOLUTE PROHIBITION - these are not in the record and must never appear:
- Dropout, graduation, attendance or chronic-absenteeism rates
- Test scores, proficiency rates or achievement-gap figures
- Per-pupil spending, budget totals or teacher salary figures
- Crime, unemployment, housing or median-income statistics
- Named partners, vendors, prior awards or prior grant history
- Any count or percentage not listed above or derived from it
=== END SCHOOL PROFILE ===
"""
