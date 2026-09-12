# Design System

> Tokens, components, motion, and PDF discipline for Smart Grant Request **v2**.
>
> Goal: **Apple Design Studio quality** — restrained, considered, and quiet.
> Linear / Apple-blue aesthetic; cool light surfaces, deep navy ink, a single
> calibrated blue primary.

---

## 1. Principles

1. **Calm by default.** UI should disappear when not needed.
2. **Cool light, never sterile.** Off-white surfaces with a soft blue tint —
   never pure `#FFF` or `#000` as a backdrop.
3. **Type carries the brand.** Serif for display, sans for UI, tabular numerals.
4. **Motion is purposeful.** No bouncy easings. Animation explains; it never
   decorates.
5. **No decorative glyphs.** Bold labels and typographic hierarchy do the work
   of icons. Emojis are stripped end to end.
6. **Accessible at AA, target AAA.** Contrast, focus rings, semantic HTML,
   keyboard-first.

---

## 2. Color tokens (Apple-blue palette)

Source of truth: [src/app/globals.css](../src/app/globals.css) `.v2-root`
block. Mirrored in [tailwind.config.js](../tailwind.config.js) (`claude.*`
namespace, retained for backward compatibility) and
[src/components/v2/pdf.ts](../src/components/v2/pdf.ts) `COLOR` constant.

| Token | Value | Use |
|---|---|---|
| `--c-bg` | `#F4F7FB` | Page background (cool soft white) |
| `--c-surface` | `#FFFFFF` | Cards, modals |
| `--c-surface-muted` | `#F8FAFD` | Subtle nested surface |
| `--c-border` | `#DCE5F0` | 1px hairlines |
| `--c-border-strong` | `#BFCEE0` | Emphasised hairlines |
| `--c-accent-muted` | `#E5EDF8` | Pills, secondary chips |
| `--c-text` | `#0B1F33` | Primary text (deep navy ink) |
| `--c-text-muted` | `#4A6079` | Secondary text, captions |
| `--c-text-subtle` | `#7B8FA8` | Placeholder, helper text |
| `--c-primary` | `#2E7CE4` | Brand — buttons, key accents, focus |
| `--c-primary-hover` | `#1E63C2` | Hover/active state |
| `--c-primary-soft` | `#CFE0F8` | Tinted backgrounds for primary surfaces |
| `--c-success` | `#208656` | Success, positive metrics |
| `--c-warning` | `#B8861B` | Warnings, attention |
| `--c-danger` | `#C64038` | Errors, destructive |

> The previous warm claude.com palette (`#F5F4EE` cream + `#D97757` orange)
> was retired during the May 2026 polish. The `.v2-root` selector is
> unchanged, so v1 surfaces are still 100% unaffected.

Dark mode is **out of scope for v2**. All tokens assume the light palette.

---

## 3. Typography

```
Display / Headings:  "Tiempos Headline", "Source Serif 4", Georgia, serif
UI / Body:           "Inter", -apple-system, BlinkMacSystemFont, sans-serif
Numerals:            tabular-nums
Code:                "JetBrains Mono", "Fira Code", ui-monospace, monospace
```

Scale:

| Token | Size / Line | Use |
|---|---|---|
| `display` | 3.5rem / 1.05 | Hero |
| `display-sm` | 2.75rem / 1.08 | Sub-hero |
| `h1` | 2.25rem / 1.15 | Page title |
| `h2` | 1.75rem / 1.2 | Section title (serif) |
| `h3` | 1.25rem / 1.3 | Subsection |
| `body` | 1rem / 1.55 | Default text |
| `small` | 0.875rem / 1.5 | Captions |
| `tiny` | 0.75rem / 1.4 | Labels, meta |

---

## 4. Spacing & layout

8-pixel grid. Common steps: `4 8 12 16 24 32 48 64 96`.

- **Page max width:** `72rem` (1152px) for content; full-bleed for hero.
- **Card padding:** `24px` desktop, `16px` mobile.
- **Section vertical rhythm:** `64px` desktop, `40px` mobile.

---

## 5. Radii & elevation

| Token | Value |
|---|---|
| `radius-sm` | `8px` |
| `radius-md` | `12px` |
| `radius-lg` | `16px` |
| `radius-xl` | `24px` (card default) |
| `shadow-1` | `0 1px 2px rgb(11 31 51 / 0.04)` |
| `shadow-2` | `0 4px 12px rgb(11 31 51 / 0.06)` |
| `shadow-3` | `0 12px 32px rgb(11 31 51 / 0.08)` |
| `shadow-focus` | `0 0 0 3px rgb(46 124 228 / 0.25)` |

---

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `dur-fast` | 120ms | Hover/focus |
| `dur-base` | 200ms | Component transitions |
| `dur-slow` | 360ms | Page/section transitions |
| `ease-out` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Default |
| `ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Symmetrical |

Reduced motion: respect `prefers-reduced-motion: reduce` — disable transforms,
keep opacity transitions ≤ 80ms.

---

## 7. Component inventory (v2)

- **Button** — primary, secondary, ghost, destructive, icon
- **Card** — default, interactive, stat
- **Field** — labelled input with helper and error states
- **Tabs** — underline (header) and pill variants
- **Badge / Chip** — neutral, accent, success, warning, danger
- **Modal / Sheet** — focus-trap, ESC to close
- **AgentStream** (collapsible) — streaming output, status, model badge
- **MetricsStrip / SuccessRing** — large numerals (tabular); the ring renders
  "Not reported" rather than a number when the run did not produce one
- **RankedGrantPicker** — the ranked list plus the deep-dive panel where the
  user chooses a target
- **ResultsPanel** — pipeline outputs in a 2-column grid, no full-application card
- **PulseCanvas / AnalyticsCanvas** — live aggregates over the open funding
  landscape

---

## 8. Emoji discipline

All decorative emojis are stripped at three layers — agents never emit them,
the UI never displays them, the PDF never renders them:

1. **Prompts** — `agent_framework_backend/v2/agents.py::_strip_emojis`
   sanitises every prompt template at import time.
2. **On-screen** — `src/components/v2/AgentStream.tsx::cleanForDisplay` and
   `src/components/v2/Markdown.tsx` strip pictographic ranges from streamed
   text and rendered markdown.
3. **PDF** — `src/components/v2/pdf.ts::sanitize` strips pictographics and
   coerces remaining text to Latin-1 (jsPDF Helvetica is WinAnsi only).

Structure is carried by **bold labels**, lists, headings, and the accent rules
under section titles — never by ◆ ▪ ▸ § ¤ glyphs.

---

## 9. Live Agent Stream

- Each agent row is a `<button>` that defaults to **collapsed** (single-line
  status pill).
- Click expands the row; body animates open with Framer Motion height +
  opacity transition.
- Per-token deltas append in place. ARIA live region (`polite`).
- When an agent completes, its row shows a single-line summary; clicking
  re-expands the full transcript.

---

## 10. Cinema PDF

The PDF output is the design system's most demanding surface — generated
client-side with jsPDF + jspdf-autotable in
[src/components/v2/pdf.ts](../src/components/v2/pdf.ts).

**Hard rules** (enforced in code, not just aspirational):

- **Cover.** Serif title, sans subtitle, school + grant + generation date.
  No success badge.
- **Section labels.** ALL-CAPS labels (`II. STATEMENT OF NEED`) and lettered
  subheadings (`A. Capacity Building`) are detected from plain text and
  rendered as styled headings with a subtle blue accent rule.
- **Keep-with-next.** Every heading and label peeks ahead at the next 1–2
  actual content blocks and reserves room for the heading **plus the real
  upcoming text** (capped at 8 lines). A heading is never stranded at the
  bottom of a page while its body spills onto the next.
- **Paragraphs.** Short paragraphs (≤ 4 lines) are kept together. Longer
  paragraphs require ≥ 2 lines on the current page or page-break first.
- **Tables.** GFM tables render via autoTable with:
  - `rowPageBreak: 'avoid'` (no row split across pages),
  - `showHead: 'everyPage'` (header repeats on each page),
  - a pre-table reservation of header + ≥ 2 body rows.
- **Footer.** "Smart Grant Request · Generated &lt;date&gt;" + page numbering,
  rendered on every page except the cover.
- **Typography.** Latin-1 only. Emojis stripped. Smart quotes / em-dashes /
  ellipses normalised. Multiple spaces collapsed.

---

## 11. Accessibility

- All interactive elements: visible focus ring (`2px solid var(--c-primary)`
  with `2px offset`).
- Color is **never** the only signal. Pair with icon or label.
- Form inputs: associated `<label>`, `aria-describedby` for helper/error.
- Live regions for streaming text (`aria-live="polite"`).
- Verify each PR with [axe DevTools](https://www.deque.com/axe/devtools/).
