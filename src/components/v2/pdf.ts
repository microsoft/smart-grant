/**
 * Cinema-grade PDF generator for grant applications.
 *
 * Produces a multi-page PDF that mirrors the structure of a real
 * federal-grant submission package:
 *
 *   1. Cover page — applicant block, funding opportunity block,
 *      requested amount, project period, submission metadata.
 *   2. Table of contents — auto-generated from the writer agent's
 *      headings, with real page numbers (two-pass rendering).
 *   3. Application body — the writer agent's full markdown, rendered
 *      with serif headings, paginated body text, autotables for
 *      markdown tables, alternating-row budgets, and orphan control.
 *   4. Certifications & Authorized Signatures — federal-style
 *      attestation block plus signature lines for the Principal and
 *      the Authorized Representative.
 *   5. Footer on every page (cover excluded).
 *
 * The implementation parses markdown line-by-line — sufficient for the
 * structured output produced by the writer agent (h1/h2/h3, paragraphs,
 * bullet lists, GFM tables, blockquotes). It is deliberately scoped to
 * what the agent produces; we don't attempt a full markdown engine.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Apple-design-studio palette — mirrored from tailwind tokens.
const COLOR = {
  ink: [11, 31, 51] as [number, number, number],            // #0B1F33 deep navy
  inkSubtle: [74, 96, 121] as [number, number, number],     // #4A6079
  paper: [252, 253, 255] as [number, number, number],       // #FCFDFF
  warmCream: [244, 247, 251] as [number, number, number],   // #F4F7FB cool soft
  primary: [46, 124, 228] as [number, number, number],      // #2E7CE4 Apple blue
  border: [220, 229, 240] as [number, number, number],      // #DCE5F0
  white: [255, 255, 255] as [number, number, number],
};

const PAGE = {
  width: 612, // letter, points
  height: 792,
  marginX: 64,
  marginTop: 72,
  marginBottom: 64,
};

/**
 * The applicant's record as held by the platform. Every field here comes
 * from the NCES Common Core of Data (via the Urban Institute Education
 * Data Portal); nothing is estimated. It drives the "Applicant Profile"
 * page so a reviewer sees the underlying figures rather than only the
 * agent's prose summary of them.
 */
export interface SchoolProfileData {
  name: string;
  district: string;
  city: string;
  state: string;
  zip: string;
  students: number;
  grades: string;
  type: string;
  demographics: {
    // `null` means the federal record does not carry the figure. Charting it
    // as 0 would be an invented statistic.
    freeReducedLunch: number | null;
    minorityEnrollment: number | null;
    englishLearners: number | null;
  };
  programs: {
    stem: boolean;
    cte: boolean;
    specialEd: boolean;
    titleI: boolean;
  };
  ncesId?: string;
  website?: string;
}

interface BuildPdfArgs {
  schoolName: string;
  schoolLocation: string;
  grantName: string;
  generatedAt: Date;
  writerMarkdown: string;
  /** Drives the Applicant Profile page. Omitted -> the page is skipped. */
  schoolProfile?: SchoolProfileData;
  /** Optional printed name; signature line is always blank for wet ink. */
  principalName?: string;
  /** Optional printed name for the Authorized Representative block. */
  authorizedRepName?: string;
}

/** Metadata extracted from the writer markdown header lines. */
interface CoverMetadata {
  projectTitle: string;
  funderName: string;
  programName: string;
  requestedAmount: string;
  projectPeriod: string;
}

/**
 * jsPDF's standard fonts only support WinAnsi (Latin-1). Strip all
 * pictographic codepoints and the substitution glyphs we previously used
 * — consulting documents read better with bold labels alone.
 */
function sanitize(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Em/en dashes are used as parenthetical breaks. Collapsing them to a
    // bare hyphen welds the surrounding words together ("inputs-equipment"),
    // so pad the replacement and let the whitespace collapse below tidy up
    // the cases where the source already had spaces.
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2300}-\u{23FF}]/gu, '')
    .replace(/[\u{2500}-\u{25FF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\u00A4|\u00A7|\u00B6/g, '')
    .replace(/\u200D/g, '')
    .replace(/[^\x00-\xFF]/g, '')
    // Collapse runs of spaces inside a line, but never at the start of one:
    // leading whitespace is what the list parser reads to work out nesting
    // depth, so flattening it here would turn every sub-bullet into a
    // top-level bullet.
    .replace(/[ \t]{2,}/g, (match, offset: number, source: string) =>
      offset === source.lastIndexOf('\n', offset - 1) + 1 ? match : ' ',
    )
    .trimEnd();
}

/**
 * Build and return a fully composed jsPDF document. Caller is
 * responsible for invoking `.save(filename)` on the returned doc.
 */
export function buildGrantPdf(args: BuildPdfArgs): jsPDF {
  const cleanArgs: BuildPdfArgs = {
    ...args,
    schoolName: sanitize(args.schoolName),
    schoolLocation: sanitize(args.schoolLocation),
    grantName: sanitize(args.grantName),
    writerMarkdown: sanitize(args.writerMarkdown),
    principalName: sanitize(args.principalName ?? ''),
    authorizedRepName: sanitize(args.authorizedRepName ?? ''),
  };

  // Split the writer markdown into (header-metadata, body) so the
  // metadata italics never repeat below the cover.
  const { body, metadata } = splitMetadata(cleanArgs);

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  // 1. Cover.
  paintCover(doc, cleanArgs, metadata);

  // 2. Reserve TOC page; will be repainted after body to get real
  //    page numbers.
  doc.addPage();
  const tocPage = doc.getNumberOfPages();

  // 3. Applicant profile — the raw NCES record behind the narrative,
  //    with charts. Reviewers verify claims against this page.
  const headingPages: Array<{ title: string; page: number }> = [];
  if (cleanArgs.schoolProfile) {
    doc.addPage();
    headingPages.push({ title: 'Applicant Profile', page: doc.getNumberOfPages() });
    paintSchoolProfile(doc, cleanArgs.schoolProfile);
  }

  // 4. Body — track (heading -> page) while rendering.
  doc.addPage();
  paintMarkdown(doc, body, {
    onHeading: (title, page) => headingPages.push({ title, page }),
  });

  // 5. Certifications & signatures page.
  doc.addPage();
  const signaturePage = doc.getNumberOfPages();
  paintSignaturePage(doc, cleanArgs);

  // 6. Repaint the TOC with real page numbers.
  doc.setPage(tocPage);
  paintTOC(doc, headingPages, signaturePage);

  // 7. Footers on every page except the cover.
  paintFooters(doc, cleanArgs);
  return doc;
}

// ---------------------------------------------------------- metadata helpers

/**
 * Parse the four header lines the writer agent emits and return both
 * the structured metadata and the body markdown with the metadata
 * lines stripped (so the body never repeats what the cover already
 * shows).
 *
 * Expected header shape:
 *
 *   # {Project Title}
 *   *Submitted to {Funder Name} - {Grant Title}*
 *   *Requested amount: ${amount}*
 *   *Submitted by: {School Name}, {City, State}*
 */
function splitMetadata(args: BuildPdfArgs): { body: string; metadata: CoverMetadata } {
  const lines = args.writerMarkdown.replace(/\r\n/g, '\n').split('\n');
  const metadata: CoverMetadata = {
    projectTitle: args.grantName,
    funderName: '',
    programName: args.grantName,
    requestedAmount: '',
    projectPeriod: '12 months from notice of award',
  };

  let cursor = 0;

  // First non-blank line is the H1 project title.
  while (cursor < lines.length && !lines[cursor].trim()) cursor++;
  const titleIdx = cursor;
  const titleMatch =
    cursor < lines.length ? /^#\s+(.*)$/.exec(lines[cursor].trim()) : null;
  if (titleMatch) {
    metadata.projectTitle = titleMatch[1].trim();
    cursor++;
  }

  // Walk subsequent italic metadata lines (allow blanks between).
  const headerEnd = Math.min(lines.length, cursor + 12);
  const consumed = new Set<number>();
  if (titleMatch) consumed.add(titleIdx);

  for (let i = cursor; i < headerEnd; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (!raw.startsWith('*') || !raw.endsWith('*')) break;
    const inner = raw.replace(/^\*+|\*+$/g, '').trim();

    const submittedTo = /^submitted to\s+(.+?)(?:\s+[-\u2013\u2014]\s+(.+))?$/i.exec(inner);
    const requested = /^requested amount[:\s]+\$?([\d,]+)/i.exec(inner);
    const submittedBy = /^submitted by[:\s]+(.+)$/i.exec(inner);
    const projectPeriod = /^project period[:\s]+(.+)$/i.exec(inner);

    if (submittedTo) {
      metadata.funderName = submittedTo[1].trim();
      if (submittedTo[2]) metadata.programName = submittedTo[2].trim();
      consumed.add(i);
    } else if (requested) {
      const n = Number(requested[1].replace(/,/g, ''));
      metadata.requestedAmount = Number.isFinite(n)
        ? `$${n.toLocaleString('en-US')}`
        : `$${requested[1]}`;
      consumed.add(i);
    } else if (submittedBy) {
      // Already in cleanArgs, but record consumption so we don't
      // duplicate the italic line in the body.
      consumed.add(i);
    } else if (projectPeriod) {
      metadata.projectPeriod = projectPeriod[1].trim();
      consumed.add(i);
    } else {
      // Unknown italic line — leave in body.
      break;
    }
  }

  // Build body: drop title + consumed italic metadata, trim leading blanks.
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    body.push(lines[i]);
  }
  while (body.length && !body[0].trim()) body.shift();

  return { body: body.join('\n'), metadata };
}

// ---------------------------------------------------------------- cover page

function paintCover(doc: jsPDF, args: BuildPdfArgs, meta: CoverMetadata): void {
  // Background fill.
  doc.setFillColor(...COLOR.warmCream);
  doc.rect(0, 0, PAGE.width, PAGE.height, 'F');

  // Accent strip on the left edge.
  doc.setFillColor(...COLOR.primary);
  doc.rect(0, 0, 8, PAGE.height, 'F');

  // Brand wordmark (top-left).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('SMART GRANT REQUEST', PAGE.marginX, 88);

  // Eyebrow.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.primary);
  doc.text('GRANT APPLICATION', PAGE.marginX, 200);

  // Project title — serif, large, wrapping up to 3 lines.
  doc.setFont('times', 'normal');
  doc.setFontSize(34);
  doc.setTextColor(...COLOR.ink);
  const titleLines = doc
    .splitTextToSize(meta.projectTitle, PAGE.width - PAGE.marginX * 2)
    .slice(0, 3);
  let titleY = 232;
  for (const line of titleLines) {
    doc.text(line, PAGE.marginX, titleY);
    titleY += 38;
  }

  // Hairline rule under title.
  const ruleY = titleY + 4;
  doc.setDrawColor(...COLOR.border);
  doc.setLineWidth(0.6);
  doc.line(PAGE.marginX, ruleY, PAGE.width - PAGE.marginX, ruleY);

  // Two-column metadata block: left = funding opportunity, right = applicant.
  const blockTop = ruleY + 36;
  const colGap = 28;
  const colWidth = (PAGE.width - PAGE.marginX * 2 - colGap) / 2;

  paintCoverColumn(
    doc,
    PAGE.marginX,
    blockTop,
    colWidth,
    'FUNDING OPPORTUNITY',
    [
      ['Program', meta.programName || args.grantName],
      ['Funder', meta.funderName || '-'],
      ['Requested amount', meta.requestedAmount || 'See § 4. Budget'],
      ['Project period', meta.projectPeriod],
    ],
  );

  paintCoverColumn(
    doc,
    PAGE.marginX + colWidth + colGap,
    blockTop,
    colWidth,
    'APPLICANT',
    [
      ['Organization', args.schoolName],
      ['Location', args.schoolLocation || '-'],
      ['Applicant type', 'Local Educational Agency (LEA)'],
      ['Submission date', formatLongDate(args.generatedAt)],
    ],
  );

  // Footer attestation strip.
  const stripY = PAGE.height - 96;
  doc.setDrawColor(...COLOR.border);
  doc.setLineWidth(0.4);
  doc.line(PAGE.marginX, stripY, PAGE.width - PAGE.marginX, stripY);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('PREPARED FOR REVIEW BY', PAGE.marginX, stripY + 18);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.ink);
  doc.text(
    'Authorized Representative of the Applicant',
    PAGE.marginX,
    stripY + 34,
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text(
    'Signatures on file. See "Certifications and Authorized Signatures" at the end of this document.',
    PAGE.marginX,
    stripY + 50,
    { maxWidth: PAGE.width - PAGE.marginX * 2 },
  );
}

function paintCoverColumn(
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  label: string,
  rows: Array<[string, string]>,
): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.primary);
  doc.text(label, x, y);

  doc.setDrawColor(...COLOR.primary);
  doc.setLineWidth(1.2);
  doc.line(x, y + 4, x + 24, y + 4);

  let cursorY = y + 22;
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(k.toUpperCase(), x, cursorY);
    cursorY += 12;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ink);
    const wrapped = doc.splitTextToSize(v || '-', width);
    for (const w of wrapped.slice(0, 3)) {
      doc.text(w, x, cursorY);
      cursorY += 14;
    }
    cursorY += 6;
  }
}

// ---------------------------------------------------------------- TOC

function paintTOC(
  doc: jsPDF,
  headings: Array<{ title: string; page: number }>,
  signaturePage: number,
): void {
  paintSectionHeader(doc, 'Table of Contents');

  // Keep at most 16 entries so the TOC fits on a single page comfortably.
  const items = headings.slice(0, 16);

  let y = 200;
  const lineSpacing = 24;
  const leftX = PAGE.marginX;
  const rightX = PAGE.width - PAGE.marginX;
  const numWidth = 26;
  const pageColWidth = 32;

  for (let idx = 0; idx < items.length; idx++) {
    const { title, page } = items[idx];
    const num = String(idx + 1).padStart(2, '0');
    const pageLabel = String(page);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(num, leftX, y);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ink);
    const titleX = leftX + numWidth;
    const titleMaxWidth = rightX - titleX - pageColWidth - 12;
    const titleText = doc.splitTextToSize(title, titleMaxWidth)[0] ?? title;
    doc.text(titleText, titleX, y);

    // Leader dots.
    const titleWidth = doc.getTextWidth(titleText);
    const dotsStart = titleX + titleWidth + 6;
    const dotsEnd = rightX - pageColWidth - 4;
    if (dotsEnd > dotsStart) {
      doc.setTextColor(...COLOR.border);
      const dotChar = '.';
      const dotW = doc.getTextWidth(dotChar);
      const count = Math.max(0, Math.floor((dotsEnd - dotsStart) / Math.max(dotW, 2)));
      if (count > 0) {
        doc.text(dotChar.repeat(count), dotsStart, y);
      }
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.ink);
    doc.text(pageLabel, rightX, y, { align: 'right' });

    y += lineSpacing;
    if (y > PAGE.height - PAGE.marginBottom - 60) break;
  }

  // Signatures row.
  y += 8;
  doc.setDrawColor(...COLOR.border);
  doc.setLineWidth(0.4);
  doc.line(leftX, y - 14, rightX, y - 14);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('CLOSING', leftX, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.ink);
  doc.text('Certifications and Authorized Signatures', leftX + 26, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(String(signaturePage), rightX, y, { align: 'right' });
}

function paintSectionHeader(doc: jsPDF, title: string): void {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.primary);
  doc.text(title.toUpperCase(), PAGE.marginX, 100);

  doc.setFont('times', 'normal');
  doc.setFontSize(28);
  doc.setTextColor(...COLOR.ink);
  doc.text(title, PAGE.marginX, 132);

  doc.setDrawColor(...COLOR.primary);
  doc.setLineWidth(2);
  doc.line(PAGE.marginX, 146, PAGE.marginX + 48, 146);
}

// ---------------------------------------------------- signatures & certs page

function paintSignaturePage(doc: jsPDF, args: BuildPdfArgs): void {
  paintSectionHeader(doc, 'Certifications and Authorized Signatures');

  let y = 188;

  // Certification preamble.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...COLOR.ink);
  const preamble = doc.splitTextToSize(
    'To the best knowledge and belief of the undersigned, the data in this application are true and correct. ' +
      'The applicant agrees to comply with the assurances and certifications below if the award is accepted, and ' +
      'acknowledges that any false, fictitious, or fraudulent statements or claims may subject the applicant to ' +
      'criminal, civil, or administrative penalties (U.S. Code, Title 18, Section 1001).',
    PAGE.width - PAGE.marginX * 2,
  );
  for (const line of preamble) {
    doc.text(line, PAGE.marginX, y);
    y += 15;
  }
  y += 14;

  // Assurances list — standard ED.gov SF-424 boilerplate, condensed.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('ASSURANCES AND CERTIFICATIONS', PAGE.marginX, y);
  doc.setDrawColor(...COLOR.primary);
  doc.setLineWidth(1.2);
  doc.line(PAGE.marginX, y + 4, PAGE.marginX + 24, y + 4);
  y += 22;

  const assurances: Array<[string, string]> = [
    [
      'Non-Discrimination',
      'The applicant will comply with Title VI of the Civil Rights Act of 1964, Title IX of the Education Amendments of 1972, Section 504 of the Rehabilitation Act of 1973, and the Age Discrimination Act of 1975.',
    ],
    [
      'Drug-Free Workplace',
      'The applicant will provide a drug-free workplace in accordance with the Drug-Free Workplace Act of 1988 (41 U.S.C. 8101 et seq.).',
    ],
    [
      'Lobbying Restriction',
      'No federal appropriated funds have been paid, or will be paid, by or on behalf of the applicant, to any person for influencing or attempting to influence an officer or employee of any agency in connection with this award (31 U.S.C. 1352).',
    ],
    [
      'Financial Management',
      'The applicant has, or will adopt, financial management systems that comply with 2 CFR Part 200 (Uniform Administrative Requirements, Cost Principles, and Audit Requirements for Federal Awards).',
    ],
    [
      'Records Retention',
      'The applicant will retain all financial and programmatic records, supporting documents, and statistical records pertinent to this award for a period of three years from the date of submission of the final expenditure report.',
    ],
  ];

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  for (const [label, text] of assurances) {
    y = ensureSpace(doc, y, 48);

    // Checkbox.
    doc.setDrawColor(...COLOR.ink);
    doc.setLineWidth(0.6);
    doc.rect(PAGE.marginX, y - 9, 9, 9);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOR.ink);
    doc.text(label, PAGE.marginX + 18, y);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLOR.inkSubtle);
    const body = doc.splitTextToSize(text, PAGE.width - PAGE.marginX * 2 - 18);
    let by = y + 14;
    for (const ln of body) {
      doc.text(ln, PAGE.marginX + 18, by);
      by += 13;
    }
    y = by + 8;
  }

  // Signature blocks — Principal + Authorized Representative.
  y = ensureSpace(doc, y + 16, 220);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('AUTHORIZED SIGNATURES', PAGE.marginX, y);
  doc.setDrawColor(...COLOR.primary);
  doc.setLineWidth(1.2);
  doc.line(PAGE.marginX, y + 4, PAGE.marginX + 24, y + 4);
  y += 28;

  paintSignatureBlock(
    doc,
    y,
    'Principal',
    args.principalName || '',
    args.schoolName,
  );
  y += 108;

  paintSignatureBlock(
    doc,
    y,
    'Superintendent / Authorized Representative',
    args.authorizedRepName || '',
    args.schoolName,
  );
}

function paintSignatureBlock(
  doc: jsPDF,
  y: number,
  role: string,
  printedName: string,
  organization: string,
): void {
  const colGap = 24;
  const sigWidth = (PAGE.width - PAGE.marginX * 2 - colGap) * 0.62;
  const dateWidth = (PAGE.width - PAGE.marginX * 2 - colGap) * 0.38;

  // Role label.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.primary);
  doc.text(role.toUpperCase(), PAGE.marginX, y);

  // Signature line.
  const lineY = y + 44;
  doc.setDrawColor(...COLOR.ink);
  doc.setLineWidth(0.6);
  doc.line(PAGE.marginX, lineY, PAGE.marginX + sigWidth, lineY);
  doc.line(
    PAGE.marginX + sigWidth + colGap,
    lineY,
    PAGE.marginX + sigWidth + colGap + dateWidth,
    lineY,
  );

  // Underline captions.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text('Signature', PAGE.marginX, lineY + 12);
  doc.text('Date', PAGE.marginX + sigWidth + colGap, lineY + 12);

  // Printed name & title block under the signature line.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.ink);
  doc.text(printedName || '__________________________', PAGE.marginX, lineY + 34);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text(`${role}, ${organization}`, PAGE.marginX, lineY + 48);
}

// ---------------------------------------------------------------- markdown

interface PaintOpts {
  startY?: number;
  /** Called for each h1/h2 heading rendered, with its starting page. */
  onHeading?: (title: string, page: number) => void;
}

function paintMarkdown(doc: jsPDF, markdown: string, opts: PaintOpts = {}): void {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let y = opts.startY ?? PAGE.marginTop;
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Skip blank lines (used as paragraph separators).
    if (!line.trim()) {
      y += 6;
      i++;
      continue;
    }

    // Headings.
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const sizes = { 1: 22, 2: 18, 3: 14, 4: 12 } as const;
      const tops = { 1: 18, 2: 14, 3: 10, 4: 8 } as const;
      const bottoms = { 1: 8, 2: 8, 3: 6, 4: 4 } as const;
      const sz = sizes[level as 1 | 2 | 3 | 4];
      // Keep-with-next: reserve room for the heading + the actual upcoming
      // content block, capped at 8 lines. This prevents a heading + a tiny
      // one-liner ("Total Requested: $130,000") from landing at the bottom
      // of a page while the real body paragraph spills onto the next.
      const followLines = Math.min(8, estimateFollowingLines(doc, lines, i + 1));
      const needed =
        tops[level as 1 | 2 | 3 | 4] +
        sz +
        4 +
        14 * followLines +
        bottoms[level as 1 | 2 | 3 | 4];
      y = ensureSpace(doc, y, needed);
      y += tops[level as 1 | 2 | 3 | 4];
      if (level <= 2 && opts.onHeading) {
        opts.onHeading(text, doc.getNumberOfPages());
      }
      doc.setFont(level <= 2 ? 'times' : 'helvetica', level <= 2 ? 'normal' : 'bold');
      doc.setFontSize(sz);
      doc.setTextColor(...COLOR.ink);
      const wrapped = doc.splitTextToSize(text, PAGE.width - PAGE.marginX * 2);
      for (const w of wrapped) {
        y = ensureSpace(doc, y, sz + 4);
        doc.text(w, PAGE.marginX, y);
        y += sz + 2;
      }
      y += bottoms[level as 1 | 2 | 3 | 4];
      i++;
      continue;
    }

    // GFM table.
    if (line.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*[-: ]+\|/.test(lines[i + 1])) {
      const tableLines: string[] = [line];
      let j = i + 1;
      // skip the separator
      tableLines.push(lines[j]);
      j++;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      // Orphan control: never start a table at the bottom of a page.
      // Reserve room for the header row + at least two body rows so the
      // header is never stranded on its own. autoTable repeats the header
      // automatically on subsequent pages when it splits.
      const ROW_HEIGHT_EST = 28;
      y = ensureSpace(doc, y, ROW_HEIGHT_EST * 3 + 8);
      paintTable(doc, tableLines, y);
      // jsPDF-autotable updates lastAutoTable for cursor.
      const last = (
        doc as unknown as { lastAutoTable?: { finalY?: number } }
      ).lastAutoTable;
      y = (last?.finalY ?? y) + 14;
      // A budget summary table gets a companion chart: reviewers scan
      // allocation shape long before they read the line justifications.
      const series = budgetSeriesFromTable(tableLines);
      if (series) {
        y = paintBarChart(doc, y + 6, 'Budget allocation', series);
        y += 8;
      }
      i = j;
      continue;
    }

    // Bullet / ordered list. Indentation is significant: the writer agent
    // nests risk mitigations and sub-objectives two spaces under their
    // parent, and flattening that loses the structure a reviewer reads by.
    const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw.replace(/\t/g, '  '));
    if (listItem) {
      const depth = Math.min(2, Math.floor(listItem[1].length / 2));
      const ordered = /\d/.test(listItem[2]);
      const marker = ordered
        ? listItem[2]
        : ['\u2022', '\u2013', '\u00B7'][depth];

      // Lazy continuation: a following non-blank line that is not itself a
      // block opener belongs to this item, not to a new paragraph.
      let text = listItem[3];
      let j = i + 1;
      while (
        j < lines.length &&
        lines[j].trim() &&
        !/^\s*(#{1,4}\s|[-*]\s|\d+\.\s|>|\|)/.test(lines[j])
      ) {
        text += ' ' + lines[j].trim();
        j++;
      }

      const indent = PAGE.marginX + depth * 18;
      const textX = indent + 20;
      const style: FlowStyle = {
        x: textX,
        maxWidth: PAGE.width - PAGE.marginX - textX,
        lineHeight: 14,
        family: 'helvetica',
        size: 11,
        color: COLOR.ink,
      };
      const laid = layoutRuns(doc, parseInlineRuns(text), style);
      // Keep the marker with its first line: reserve both before painting.
      y = ensureSpace(doc, y, 16);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(...COLOR.inkSubtle);
      doc.text(marker, indent + 4, y);
      y = paintRunLines(doc, laid, y, style);
      y += 2;
      i = j;
      continue;
    }

    // Blockquote.
    if (line.startsWith('>')) {
      const text = line.replace(/^>\s?/, '');
      y = ensureSpace(doc, y, 18);
      doc.setDrawColor(...COLOR.primary);
      doc.setLineWidth(2);
      doc.line(PAGE.marginX, y - 10, PAGE.marginX, y + 4);
      const style: FlowStyle = {
        x: PAGE.marginX + 12,
        maxWidth: PAGE.width - PAGE.marginX * 2 - 16,
        lineHeight: 14,
        family: 'times',
        size: 11,
        color: COLOR.inkSubtle,
      };
      // Inside a quote the default voice is already italic, so emphasis
      // runs are folded back to upright for contrast.
      const runs = parseInlineRuns(text).map((r) => ({
        text: r.text,
        bold: r.bold,
        italic: !r.italic,
      }));
      y = paintRunLines(doc, layoutRuns(doc, runs, style), y, style);
      y += 6;
      i++;
      continue;
    }

    // Plain paragraph (collect adjacent non-empty lines until blank or block).
    const paragraph: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|>|\|)/.test(lines[j])
    ) {
      paragraph.push(lines[j].trim());
      j++;
    }
    const richText = paragraph.join(' ');
    const text = stripInline(richText);

    // Detect ALL-CAPS section labels (e.g. "II. STATEMENT OF NEED",
    // "BUDGET NARRATIVE AND JUSTIFICATION") that the writer agent emits
    // as plain text. Render as a styled section heading with orphan
    // control so they never strand at the bottom of a page.
    const isSectionLabel =
      paragraph.length === 1 &&
      text.length <= 80 &&
      /[A-Z]/.test(text) &&
      text === text.toUpperCase() &&
      /^[A-Z0-9][A-Z0-9 .,:;()\-/&]+$/.test(text);

    if (isSectionLabel) {
      const top = 16;
      const bottom = 8;
      const sz = 13;
      // Keep-with-next: reserve room for the label + the actual upcoming
      // content block (capped at 8 lines), not just any 3 lines.
      const followLines = Math.min(8, estimateFollowingLines(doc, lines, j));
      y = ensureSpace(doc, y, top + sz + 4 + 14 * followLines + bottom);
      y += top;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(sz);
      doc.setTextColor(...COLOR.ink);
      doc.text(text, PAGE.marginX, y);
      y += sz - 2;
      // Subtle accent rule under the label.
      doc.setDrawColor(...COLOR.primary);
      doc.setLineWidth(1);
      doc.line(PAGE.marginX, y + 2, PAGE.marginX + 36, y + 2);
      y += bottom + 4;
      i = j;
      continue;
    }

    // Detect lettered / numbered subheadings ("A. Capacity Building",
    // "D. Scalability", "1. Overview", "III. Approach"). These are
    // semantically headings that the writer agent emits as plain text;
    // we render them with a slightly stronger weight and apply the same
    // keep-with-next orphan control so the title never strands.
    const isSubheading =
      paragraph.length === 1 &&
      text.length <= 80 &&
      /^(?:[A-Z]|[IVX]{1,4}|\d{1,2})\.\s+[A-Z][A-Za-z0-9 ,&'\-/()]+$/.test(text);

    if (isSubheading) {
      const top = 12;
      const bottom = 6;
      const sz = 12;
      const followLines = Math.min(8, estimateFollowingLines(doc, lines, j));
      y = ensureSpace(doc, y, top + sz + 4 + 14 * followLines + bottom);
      y += top;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(sz);
      doc.setTextColor(...COLOR.ink);
      doc.text(text, PAGE.marginX, y);
      y += sz + bottom;
      i = j;
      continue;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.ink);
    const style: FlowStyle = {
      x: PAGE.marginX,
      maxWidth: PAGE.width - PAGE.marginX * 2,
      lineHeight: 14,
      family: 'helvetica',
      size: 11,
      color: COLOR.ink,
    };
    const laid = layoutRuns(doc, parseInlineRuns(richText), style);
    // Widow / orphan control for paragraphs:
    //   - Short paragraphs (<= 4 lines) are kept fully together.
    //   - Longer paragraphs require at least 2 lines on the current page;
    //     otherwise we break to start them at the top of a fresh page.
    const remaining = PAGE.height - PAGE.marginBottom - y;
    const linesThatFit = Math.max(0, Math.floor(remaining / 14));
    const needAllTogether = laid.length <= 4;
    if (
      (needAllTogether && linesThatFit < laid.length) ||
      (!needAllTogether && linesThatFit < 2)
    ) {
      doc.addPage();
      y = PAGE.marginTop;
    }
    y = paintRunLines(doc, laid, y, style);
    y += 6;
    i = j;
  }
}

function paintTable(doc: jsPDF, tableLines: string[], startY: number): void {
  const head = parseTableRow(tableLines[0]);
  const body = tableLines.slice(2).map(parseTableRow);
  autoTable(doc, {
    startY,
    head: [head],
    body,
    theme: 'plain',
    margin: { left: PAGE.marginX, right: PAGE.marginX, top: 56, bottom: 56 },
    // Repeat the header on every page when the table spans multiple
    // pages, and never split a single row across a page boundary.
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    headStyles: {
      fillColor: COLOR.primary,
      textColor: COLOR.white,
      fontStyle: 'bold',
      halign: 'left',
    },
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: 8,
      textColor: COLOR.ink,
      lineColor: COLOR.border,
      lineWidth: 0.4,
    },
    alternateRowStyles: {
      fillColor: COLOR.warmCream,
    },
    // A summary row ("TOTAL", "Total request") is the number a reviewer
    // checks first; it has to read as a total, not as one more line item.
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const first = body[data.row.index]?.[0]?.trim() ?? '';
      if (/^(grand\s+)?totals?\b/i.test(first)) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = COLOR.warmCream;
      }
    },
  });
}

function parseTableRow(row: string): string[] {
  return row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => stripInline(cell.trim()));
}

/** Strip the inline markdown we don't render (bold/italic/code/links). */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1');
}

// ------------------------------------------------------------ inline runs

/**
 * A stretch of text sharing one font style. The writer agent leans on
 * `**bold**` lead-ins inside list items ("**Risk: procurement delay**"),
 * so stripping the markers is not enough - the emphasis carries meaning
 * and the reviewer expects to see it typeset.
 */
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** One measured word (or run of whitespace) ready to be placed on a line. */
interface Piece extends Run {
  w: number;
}

interface FlowStyle {
  x: number;
  maxWidth: number;
  lineHeight: number;
  family: 'helvetica' | 'times';
  size: number;
  color: [number, number, number];
}

/**
 * Split inline markdown into styled runs. Only `*` emphasis is honoured -
 * underscore emphasis is deliberately ignored because identifiers such as
 * `free_reduced_lunch` appear in agent output and would be mangled.
 */
function parseInlineRuns(text: string): Run[] {
  const src = text
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/`(.+?)`/g, '$1');
  const runs: Run[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      runs.push({ text: src.slice(last, m.index), bold: false, italic: false });
    }
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true, italic: false });
    else runs.push({ text: m[2], bold: false, italic: true });
    last = re.lastIndex;
  }
  if (last < src.length) {
    runs.push({ text: src.slice(last), bold: false, italic: false });
  }
  return runs.filter((r) => r.text.length > 0);
}

function fontStyle(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'bolditalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'normal';
}

/**
 * Word-wrap styled runs into lines. Measurement has to happen per piece
 * because bold glyphs are wider than regular ones - wrapping on the plain
 * width would overflow the measure on bold-heavy lines.
 */
function layoutRuns(doc: jsPDF, runs: Run[], style: FlowStyle): Piece[][] {
  const pieces: Piece[] = [];
  for (const run of runs) {
    doc.setFont(style.family, fontStyle(run.bold, run.italic));
    doc.setFontSize(style.size);
    for (const token of run.text.split(/(\s+)/)) {
      if (!token) continue;
      pieces.push({ ...run, text: token, w: doc.getTextWidth(token) });
    }
  }

  const lines: Piece[][] = [];
  let current: Piece[] = [];
  let width = 0;
  for (const piece of pieces) {
    const isSpace = /^\s+$/.test(piece.text);
    if (isSpace && current.length === 0) continue;
    if (!isSpace && current.length > 0 && width + piece.w > style.maxWidth) {
      lines.push(current);
      current = [];
      width = 0;
    }
    current.push(piece);
    width += piece.w;
  }
  if (current.length) lines.push(current);
  return lines;
}

/** Paint pre-laid-out lines, paginating as needed. Returns the new y. */
function paintRunLines(
  doc: jsPDF,
  lines: Piece[][],
  y: number,
  style: FlowStyle,
): number {
  for (const line of lines) {
    y = ensureSpace(doc, y, style.lineHeight);
    let x = style.x;
    // Trailing whitespace must not shift right-hand pieces or widen the
    // measure; drop it at paint time rather than at layout time so the
    // wrap decision above still accounts for it.
    let end = line.length;
    while (end > 0 && /^\s+$/.test(line[end - 1].text)) end--;
    // Consecutive pieces that share a style are emitted as one text run.
    // Drawing word by word would work visually but fragments the PDF text
    // layer, which breaks copy/paste and reviewer keyword search.
    let k = 0;
    while (k < end) {
      const { bold, italic } = line[k];
      let text = '';
      let width = 0;
      while (k < end && line[k].bold === bold && line[k].italic === italic) {
        text += line[k].text;
        width += line[k].w;
        k++;
      }
      doc.setFont(style.family, fontStyle(bold, italic));
      doc.setFontSize(style.size);
      doc.setTextColor(...style.color);
      doc.text(text, x, y);
      x += width;
    }
    y += style.lineHeight;
  }
  return y;
}

// -------------------------------------------------------------- charts

/** One row of a horizontal bar chart. */
interface ChartRow {
  label: string;
  value: number;
  /** Right-hand annotation, e.g. "$84,000  ·  32%". */
  display: string;
}

/** Mix a colour toward white. `amount` 0 = base, 1 = white. */
function tint(
  base: [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    Math.round(base[0] + (255 - base[0]) * amount),
    Math.round(base[1] + (255 - base[1]) * amount),
    Math.round(base[2] + (255 - base[2]) * amount),
  ];
}

/**
 * Horizontal bar chart drawn with native vector primitives - no canvas,
 * no raster, so it stays crisp at any zoom and adds no dependency. Bars
 * are scaled against the largest value by default; pass `max` for series
 * that share a fixed scale, such as percentages of a population.
 */
function paintBarChart(
  doc: jsPDF,
  y: number,
  title: string,
  rows: ChartRow[],
  opts: { labelWidth?: number; valueWidth?: number; max?: number } = {},
): number {
  if (!rows.length) return y;
  const labelWidth = opts.labelWidth ?? 130;
  const valueWidth = opts.valueWidth ?? 96;
  const barHeight = 13;
  const gap = 9;
  const left = PAGE.marginX;
  const right = PAGE.width - PAGE.marginX;
  const trackX = left + labelWidth + 10;
  const trackW = right - valueWidth - 6 - trackX;

  // Keep the whole chart on one page - a bar chart split across a page
  // break is unreadable.
  const needed = 26 + rows.length * (barHeight + gap) + 10;
  y = ensureSpace(doc, y, needed);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.primary);
  doc.text(title.toUpperCase(), left, y);
  y += 6;
  doc.setDrawColor(...COLOR.border);
  doc.setLineWidth(0.4);
  doc.line(left, y, right, y);
  y += 16;

  const max = Math.max(opts.max ?? 0, ...rows.map((r) => r.value), 1);
  rows.forEach((row, index) => {
    const barY = y - barHeight + 3;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.ink);
    doc.text(row.label, left, y, { maxWidth: labelWidth });

    doc.setFillColor(...COLOR.warmCream);
    doc.rect(trackX, barY, trackW, barHeight, 'F');

    const filled = Math.max(1.5, (row.value / max) * trackW);
    // Step the fill from the brand blue toward a paler tint so adjacent
    // bars stay distinguishable in greyscale printing too.
    doc.setFillColor(...tint(COLOR.primary, Math.min(0.55, index * 0.11)));
    doc.rect(trackX, barY, filled, barHeight, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(row.display, right, y, { align: 'right' });

    y += barHeight + gap;
  });
  return y + 4;
}

/**
 * Recognise a budget summary table and turn it into chart rows. Returns
 * null for any table that is not a category/amount pair, so timelines,
 * logic models and evaluation matrices pass through untouched.
 */
function budgetSeriesFromTable(tableLines: string[]): ChartRow[] | null {
  const head = parseTableRow(tableLines[0]).map((h) => h.toLowerCase());
  const labelIndex = head.findIndex(
    (h) => h.includes('categor') || h.includes('line item') || h.includes('budget item'),
  );
  const amountIndex = head.findIndex(
    (h) => h.includes('amount') || h.includes('cost') || h.includes('request'),
  );
  if (labelIndex === -1 || amountIndex === -1) return null;

  const rows: ChartRow[] = [];
  for (const raw of tableLines.slice(2)) {
    const cells = parseTableRow(raw);
    const label = cells[labelIndex] ?? '';
    const amountCell = cells[amountIndex] ?? '';
    if (!label || /^total\b/i.test(label.trim())) continue;
    const numeric = Number(amountCell.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    rows.push({ label: label.trim(), value: numeric, display: '' });
  }
  if (rows.length < 3) return null;

  const total = rows.reduce((sum, r) => sum + r.value, 0);
  for (const row of rows) {
    const pct = total ? Math.round((row.value / total) * 100) : 0;
    row.display = `$${Math.round(row.value).toLocaleString('en-US')}  ${pct}%`;
  }
  return rows;
}

// ------------------------------------------------------- applicant profile

/**
 * The applicant's verifiable record, rendered as its own page. Reviewers
 * routinely cross-check narrative claims against source data; putting the
 * NCES figures and their derived counts on one page - with the
 * demographic mix charted - makes that check a glance instead of a hunt.
 */
function paintSchoolProfile(doc: jsPDF, profile: SchoolProfileData): void {
  paintSectionHeader(doc, 'Applicant Profile');
  let y = 186;

  const enrolled = profile.students || 0;
  const countOf = (pct: number) =>
    enrolled ? Math.round((enrolled * pct) / 100) : 0;

  // --- identity tiles ------------------------------------------------
  const tiles: Array<[string, string]> = [
    ['ENROLMENT', enrolled ? enrolled.toLocaleString('en-US') : 'Not reported'],
    ['GRADES SERVED', sanitize(profile.grades) || 'Not reported'],
    ['GOVERNANCE', sanitize(profile.type) || 'Not reported'],
    ['NCES ID', sanitize(profile.ncesId ?? '') || 'Not reported'],
  ];
  const tileW = (PAGE.width - PAGE.marginX * 2 - 12 * 3) / 4;
  tiles.forEach(([label, value], index) => {
    const x = PAGE.marginX + index * (tileW + 12);
    doc.setFillColor(...COLOR.warmCream);
    doc.rect(x, y, tileW, 52, 'F');
    doc.setDrawColor(...COLOR.border);
    doc.setLineWidth(0.4);
    doc.rect(x, y, tileW, 52, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLOR.primary);
    doc.text(label, x + 10, y + 17);

    doc.setFont('times', 'normal');
    doc.setFontSize(15);
    doc.setTextColor(...COLOR.ink);
    doc.text(value, x + 10, y + 39, { maxWidth: tileW - 20 });
  });
  y += 52 + 26;

  // --- record rows ---------------------------------------------------
  const rows: Array<[string, string]> = [
    ['Legal name', sanitize(profile.name)],
    ['District (LEA)', sanitize(profile.district) || 'Not reported'],
    [
      'Location',
      sanitize(
        [profile.city, profile.state].filter(Boolean).join(', ') +
          (profile.zip ? ` ${profile.zip}` : ''),
      ) || 'Not reported',
    ],
    ['Title I status', profile.programs.titleI ? 'Title I school' : 'Not documented'],
    ['Website', sanitize(profile.website ?? '') || 'Not reported'],
  ];
  doc.setFontSize(10);
  for (const [label, value] of rows) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(label, PAGE.marginX, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLOR.ink);
    doc.text(value, PAGE.marginX + 132, y, {
      maxWidth: PAGE.width - PAGE.marginX * 2 - 132,
    });
    y += 17;
  }
  y += 14;

  // --- demographic chart ---------------------------------------------
  const demo = profile.demographics;
  const demoMeasures: Array<[string, number | null]> = [
    ['Free/reduced-price lunch', demo.freeReducedLunch],
    ['Minority enrolment', demo.minorityEnrollment],
    ['English learners', demo.englishLearners],
  ];
  // Only measures that are actually on record get a bar. A missing figure is
  // listed underneath as unreported rather than drawn as zero.
  const demoRows: ChartRow[] = [];
  const unreported: string[] = [];
  for (const [label, pct] of demoMeasures) {
    if (pct === null) {
      unreported.push(label);
      continue;
    }
    demoRows.push({
      label,
      value: pct,
      display: enrolled
        ? `${pct}%  ~${countOf(pct).toLocaleString('en-US')} students`
        : `${pct}%`,
    });
  }

  if (demoRows.length) {
    // Percentages share one scale, so the bars are drawn against 100 rather
    // than against the largest value - otherwise 42% would fill the track
    // and read as "everyone".
    y = paintBarChart(doc, y, 'Student population mix', demoRows, {
      labelWidth: 150,
      valueWidth: 132,
      max: 100,
    });
  }

  if (unreported.length) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(
      `Not reported in the federal directory record: ${unreported.join(', ')}.`,
      PAGE.marginX,
      y,
      { maxWidth: PAGE.width - PAGE.marginX * 2 },
    );
    y += 18;
  }

  // --- programs ------------------------------------------------------
  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.primary);
  doc.text('PROGRAMS ON RECORD', PAGE.marginX, y);
  y += 6;
  doc.setDrawColor(...COLOR.border);
  doc.setLineWidth(0.4);
  doc.line(PAGE.marginX, y, PAGE.width - PAGE.marginX, y);
  y += 18;

  const programs: Array<[string, boolean]> = [
    ['STEM program', profile.programs.stem],
    ['Career & technical education', profile.programs.cte],
    ['Special education services', profile.programs.specialEd],
    ['Title I', profile.programs.titleI],
  ];
  const colW = (PAGE.width - PAGE.marginX * 2) / 2;
  programs.forEach(([label, present], index) => {
    const x = PAGE.marginX + (index % 2) * colW;
    const rowY = y + Math.floor(index / 2) * 20;
    doc.setFillColor(...(present ? COLOR.primary : COLOR.border));
    doc.circle(x + 4, rowY - 3, 3.2, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.ink);
    doc.text(label, x + 14, y + Math.floor(index / 2) * 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(present ? 'On record' : 'Not documented', x + colW - 24, rowY, {
      align: 'right',
    });
  });
  y += 2 * 20 + 20;

  // --- provenance ----------------------------------------------------
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.inkSubtle);
  doc.text(
    'Source: NCES Common Core of Data, retrieved via the Urban Institute Education Data Portal. '
      + 'Student counts are derived arithmetically from the reported enrolment and percentages; '
      + '"Not documented" indicates the federal record is silent on that item, not that the program is absent.',
    PAGE.marginX,
    y,
    { maxWidth: PAGE.width - PAGE.marginX * 2 },
  );
}

// ---------------------------------------------------------------- pagination

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE.height - PAGE.marginBottom) {
    doc.addPage();
    return PAGE.marginTop;
  }
  return y;
}

/**
 * Estimate how many wrapped 11pt body lines the upcoming markdown content
 * would consume on the current page width. Used by heading orphan / keep-
 * with-next control: a heading + a one-line "Total: $X" caption + a long
 * paragraph should not strand the long paragraph on the next page.
 *
 * Walks forward across blank lines and collects the next 1-2 logical
 * blocks (paragraphs, list items, table rows). Returns at minimum 3 lines
 * so a heading is never followed by zero reservation.
 */
function estimateFollowingLines(doc: jsPDF, lines: string[], start: number): number {
  let i = start;
  let total = 0;
  let blocksSeen = 0;
  const maxBlocks = 2;
  const width = PAGE.width - PAGE.marginX * 2;
  // Save font state — splitTextToSize uses the current font.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  while (i < lines.length && blocksSeen < maxBlocks && total < 16) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Stop at the next heading / section label — we don't pull across
    // boundaries.
    if (/^#{1,4}\s/.test(line)) break;
    // Tables: count rows as 1.5 lines each.
    if (line.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*[-: ]+\|/.test(lines[i + 1])) {
      let j = i + 2;
      let rows = 1;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        rows++;
        j++;
      }
      total += Math.ceil(rows * 1.8);
      i = j;
      blocksSeen++;
      continue;
    }
    // List items: 1 line each minimum.
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const text = line.replace(/^\s*([-*]|\d+\.)\s+/, '');
      const wrapped = doc.splitTextToSize(text, width - 24);
      total += wrapped.length;
      i++;
      blocksSeen++;
      continue;
    }
    // Paragraph: collect adjacent non-empty lines.
    const paragraph: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|>|\|)/.test(lines[j])
    ) {
      paragraph.push(lines[j].trim());
      j++;
    }
    const text = paragraph
      .join(' ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1');
    const wrapped = doc.splitTextToSize(text, width);
    total += wrapped.length;
    i = j;
    blocksSeen++;
  }
  return Math.max(3, total);
}

function paintFooters(doc: jsPDF, args: BuildPdfArgs): void {
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    if (p === 1) continue; // skip the cover
    doc.setPage(p);
    doc.setDrawColor(...COLOR.border);
    doc.setLineWidth(0.4);
    doc.line(PAGE.marginX, PAGE.height - 44, PAGE.width - PAGE.marginX, PAGE.height - 44);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.inkSubtle);
    doc.text(
      `${args.schoolName} - ${args.grantName}`,
      PAGE.marginX,
      PAGE.height - 28,
      { maxWidth: PAGE.width - PAGE.marginX * 2 - 80 },
    );
    doc.text(`Page ${p} of ${total}`, PAGE.width - PAGE.marginX, PAGE.height - 28, {
      align: 'right',
    });
  }
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
