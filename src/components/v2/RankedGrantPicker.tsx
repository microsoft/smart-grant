'use client';

/**
 * RankedGrantPicker — Apple-blue Human-In-The-Loop selector.
 *
 * Rendered after the Discovery agent emits its rubric-scored ranking. The
 * user reviews up to five candidates (with full score breakdown, pros,
 * cons, and methodology), then confirms one before the generation stage
 * runs. A small "rejected" panel acknowledges grants that failed the hard
 * disqualifiers, so the user can see *why* a result they expected is not
 * in the list.
 *
 * Design language: matches the rest of v2 (Apple-blue palette, serif
 * titles, subtle elevation, restrained iconography).
 */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Info,
  MapPin,
  Search,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { Card, CardTitle, CardDescription } from './Card';
import { Button } from './Button';
import { Badge } from './Badge';
import { cn } from './cn';

// ----------------------------------------------------------- shared types
//
// Mirror of v2/schemas.py — kept structurally identical so the SSE payload
// hydrates directly. We intentionally avoid pulling these from a shared
// schema package to keep the frontend self-contained.

export type RubricKey =
  | 'eligibility_fit'
  | 'mission_alignment'
  | 'demographic_resonance'
  | 'award_size_fit'
  | 'competition_odds'
  | 'timeline_feasibility'
  | 'sustainability_potential'
  | 'strategic_upside';

export interface RubricScore {
  eligibility_fit: number;
  mission_alignment: number;
  demographic_resonance: number;
  award_size_fit: number;
  competition_odds: number;
  timeline_feasibility: number;
  sustainability_potential: number;
  strategic_upside: number;
}

export interface RankedGrant {
  id: string;
  rank: number;
  title: string;
  funder: string;
  source: string;
  url: string | null;
  amount_text: string;
  amount_low_usd: number | null;
  amount_high_usd: number | null;
  deadline_text: string;
  deadline_iso: string | null;
  summary: string;
  score: RubricScore;
  score_total: number;
  pros: string[];
  cons: string[];
  why_this_rank: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface DisqualifiedGrant {
  title: string;
  funder: string;
  reason: string;
}

export interface FoundationFinancials {
  latest_year?: number | null;
  form_type?: string | null;
  total_assets_usd?: number | null;
  total_revenue_usd?: number | null;
  total_expenses_usd?: number | null;
  grants_paid_annual_usd?: number | null;
  estimated_avg_grant_usd?: number | null;
  pdf_url?: string | null;
  years_on_record?: number;
}

export interface FoundationScoreBreakdown {
  capacity: number;
  activity: number;
  recency: number;
  geographic_fit: number;
  focus_fit: number;
  scale_fit: number;
}

export interface FoundationProspect {
  id: string;
  name: string;
  focus: string;
  city?: string | null;
  state?: string | null;
  ein: string;
  url: string;
  note?: string;
  rank?: number | null;
  score?: number;
  score_breakdown?: FoundationScoreBreakdown | null;
  confidence?: 'high' | 'medium' | 'low';
  pros?: string[];
  cons?: string[];
  risk_flags?: string[];
  likely_give_range_usd?: { low: number; high: number } | null;
  financials?: FoundationFinancials | null;
  recommended_next_step?: string;
}

export interface DiscoveryRanking {
  summary: string;
  total_grants_searched: number;
  sources: Record<string, number>;
  top_grants: RankedGrant[];
  disqualified: DisqualifiedGrant[];
  rubric_explanation: string;
  foundation_prospects?: FoundationProspect[];
}

// ----------------------------------------------------------- rubric meta

const RUBRIC_META: Array<{ key: RubricKey; label: string; max: number; tip: string }> = [
  { key: 'eligibility_fit', label: 'Eligibility fit', max: 25, tip: 'School type, state, grade level, and prerequisite match.' },
  { key: 'mission_alignment', label: 'Mission alignment', max: 20, tip: "Stated funder priorities vs. the school's program intent." },
  { key: 'demographic_resonance', label: 'Demographic resonance', max: 15, tip: 'Funder preferences for the populations this school serves.' },
  { key: 'award_size_fit', label: 'Award size fit', max: 10, tip: 'Realistic for the program scope (avoid both too-small and too-large).' },
  { key: 'competition_odds', label: 'Competition odds', max: 10, tip: 'Inverse of expected applicant pool & selectivity.' },
  { key: 'timeline_feasibility', label: 'Timeline feasibility', max: 10, tip: 'Days available to assemble a strong, honest application.' },
  { key: 'sustainability_potential', label: 'Sustainability', max: 5, tip: 'Likelihood of renewal or post-grant continuation.' },
  { key: 'strategic_upside', label: 'Strategic upside', max: 5, tip: 'Reputation, networks, and follow-on opportunity.' },
];

const CONFIDENCE_TONE: Record<RankedGrant['confidence'], 'success' | 'primary' | 'warning'> = {
  high: 'success',
  medium: 'primary',
  low: 'warning',
};

// ----------------------------------------------------------- component

interface Props {
  ranking: DiscoveryRanking;
  onConfirm: (target: RankedGrant | FoundationProspect) => void;
  onRestart: () => void;
  disabled?: boolean;
}

export function RankedGrantPicker({ ranking, onConfirm, onRestart, disabled }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    ranking.top_grants[0]?.id ?? null,
  );
  const [showMethodology, setShowMethodology] = useState(false);
  const [showDisqualified, setShowDisqualified] = useState(false);

  const selected = useMemo(
    () => ranking.top_grants.find((g) => g.id === selectedId) ?? null,
    [ranking.top_grants, selectedId],
  );

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
      className="space-y-6"
      aria-labelledby="ranked-picker-title"
    >
      {/* ---------------------------------------------------------- header */}
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge tone="primary" soft>
            Step 2 · Choose the grant
          </Badge>
          <Badge tone="neutral" soft>
            {ranking.total_grants_searched.toLocaleString()} candidates reviewed
          </Badge>
        </div>
        <h2
          id="ranked-picker-title"
          className="font-serif text-h2 text-claude-text tracking-tight"
        >
          The Discovery agent shortlisted {ranking.top_grants.length} strong matches.
        </h2>
        <p className="text-claude-text-muted max-w-2xl">{ranking.summary}</p>
      </header>

      {/* ----------------------------------------------------- methodology */}
      <Card density="compact" className="bg-claude-surface-muted/40">
        <button
          type="button"
          onClick={() => setShowMethodology((v) => !v)}
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={showMethodology}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-claude-text">
            <Info className="h-4 w-4 text-claude-primary" />
            How were these scored?
          </span>
          {showMethodology ? (
            <ChevronUp className="h-4 w-4 text-claude-text-subtle" />
          ) : (
            <ChevronDown className="h-4 w-4 text-claude-text-subtle" />
          )}
        </button>
        {showMethodology && (
          <p className="mt-3 text-sm text-claude-text-muted leading-relaxed">
            {ranking.rubric_explanation}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------ candidates */}
      <div className="grid gap-4">
        {ranking.top_grants.map((g) => (
          <GrantCard
            key={g.id}
            grant={g}
            selected={g.id === selectedId}
            onSelect={() => setSelectedId(g.id)}
          />
        ))}
      </div>

      {/* ------------------------------------------------------ rejected */}
      {ranking.disqualified.length > 0 && (
        <Card density="compact">
          <button
            type="button"
            onClick={() => setShowDisqualified((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={showDisqualified}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-claude-text">
              <XCircle className="h-4 w-4 text-claude-text-subtle" />
              {ranking.disqualified.length} grants were filtered out
            </span>
            {showDisqualified ? (
              <ChevronUp className="h-4 w-4 text-claude-text-subtle" />
            ) : (
              <ChevronDown className="h-4 w-4 text-claude-text-subtle" />
            )}
          </button>
          {showDisqualified && (
            <ul className="mt-3 space-y-2">
              {ranking.disqualified.map((d, i) => (
                <li
                  key={`${d.title}-${i}`}
                  className="flex items-start justify-between gap-4 text-sm border-t border-claude-border pt-2 first:border-t-0 first:pt-0"
                >
                  <div className="min-w-0">
                    <p className="text-claude-text truncate">{d.title}</p>
                    <p className="text-xs text-claude-text-subtle truncate">{d.funder}</p>
                  </div>
                  <span className="text-xs text-claude-text-muted shrink-0 italic">
                    {d.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ----------------------------------------------- foundation rail */}
      {ranking.foundation_prospects && ranking.foundation_prospects.length > 0 && (
        <FoundationProspectsRail
          prospects={ranking.foundation_prospects}
          onWrite={onConfirm}
          disabled={disabled}
        />
      )}

      {/* --------------------------------------------------------- action */}
      <div className="sticky bottom-4 z-10">
        <Card className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 backdrop-blur-md bg-claude-surface/95">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium">
              Selected
            </p>
            <p className="text-sm text-claude-text font-medium truncate">
              {selected ? `#${selected.rank} · ${selected.title}` : 'No grant selected.'}
            </p>
            <p className="text-xs text-claude-text-muted truncate">
              {selected ? selected.funder : 'Pick one above to continue.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              leadingIcon={<Search className="h-4 w-4" />}
              onClick={onRestart}
              disabled={disabled}
            >
              Start a new search
            </Button>
            <Button
              onClick={() => selected && onConfirm(selected)}
              disabled={!selected || disabled}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            >
              Write this application
            </Button>
          </div>
        </Card>
      </div>
    </motion.section>
  );
}

// ----------------------------------------------------------- grant card

function GrantCard({
  grant,
  selected,
  onSelect,
}: {
  grant: RankedGrant;
  selected: boolean;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(grant.rank === 1);

  return (
    <Card
      interactive
      onClick={onSelect}
      className={cn(
        'relative transition-all',
        selected
          ? 'ring-2 ring-claude-primary border-claude-primary/60 shadow-c-2'
          : 'hover:shadow-c-2',
      )}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* rank chip */}
      <div className="absolute -top-3 -left-3 h-9 w-9 rounded-full bg-claude-primary text-white text-sm font-semibold grid place-items-center shadow-c-2">
        {grant.rank}
      </div>

      <div className="flex flex-col gap-4">
        {/* row 1 — title + score */}
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h3 className="font-serif text-h3 text-claude-text tracking-tight">
              {grant.title}
            </h3>
            <p className="text-sm text-claude-text-muted mt-0.5">
              {grant.funder} · <span className="text-claude-text-subtle">{grant.source}</span>
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-serif text-4xl leading-none text-claude-primary tabular-nums">
              {grant.score_total}
              <span className="text-base text-claude-text-subtle">/100</span>
            </p>
            <Badge tone={CONFIDENCE_TONE[grant.confidence]} soft className="mt-2 capitalize">
              {grant.confidence} confidence
            </Badge>
          </div>
        </div>

        {/* row 2 — money & deadline */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <Stat label="Award" value={grant.amount_text} />
          <Stat label="Deadline" value={grant.deadline_text} />
          {grant.url && (
            <a
              href={grant.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-claude-primary hover:underline self-end"
              onClick={(e) => e.stopPropagation()}
            >
              View source <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>

        {/* row 3 — summary */}
        <p className="text-sm text-claude-text-muted leading-relaxed">{grant.summary}</p>

        {/* row 4 — why this rank */}
        <div className="rounded-c-md bg-claude-accent-muted/40 border border-claude-border px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium mb-1">
            Why it ranked #{grant.rank}
          </p>
          <p className="text-sm text-claude-text">{grant.why_this_rank}</p>
        </div>

        {/* row 5 — pros / cons */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium mb-2">
              Strengths
            </p>
            <ul className="space-y-1.5">
              {grant.pros.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-claude-text">
                  <CheckCircle2 className="h-4 w-4 text-claude-success shrink-0 mt-0.5" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium mb-2">
              Trade-offs
            </p>
            <ul className="space-y-1.5">
              {grant.cons.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-claude-text">
                  <XCircle className="h-4 w-4 text-claude-warning shrink-0 mt-0.5" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* row 6 — score breakdown (collapsible) */}
        <div className="border-t border-claude-border pt-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="flex w-full items-center justify-between text-xs uppercase tracking-wide text-claude-text-subtle font-medium hover:text-claude-text transition-colors"
            aria-expanded={expanded}
          >
            <span>Score breakdown</span>
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
          {expanded && (
            <div className="mt-4 space-y-2">
              {RUBRIC_META.map((r) => (
                <RubricBar
                  key={r.key}
                  label={r.label}
                  value={grant.score[r.key]}
                  max={r.max}
                  tip={r.tip}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------- atoms

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium">
        {label}
      </p>
      <p className="text-claude-text font-medium truncate">{value}</p>
    </div>
  );
}

function RubricBar({
  label,
  value,
  max,
  tip,
}: {
  label: string;
  value: number;
  max: number;
  tip: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(140px,180px)_1fr_56px] items-center gap-3">
      <span className="text-sm text-claude-text-muted truncate" title={tip}>
        {label}
      </span>
      <div
        className="h-2 rounded-full bg-claude-surface-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={`${label}: ${value} of ${max}`}
      >
        <div
          className="h-full bg-claude-primary rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-claude-text-subtle text-right tabular-nums">
        {value}/{max}
      </span>
    </div>
  );
}

// ------------------------------------------------ foundation prospects rail

const CONFIDENCE_TONE_FOUNDATION: Record<NonNullable<FoundationProspect['confidence']>, 'success' | 'warning' | 'neutral'> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
};

const CONFIDENCE_LABEL: Record<NonNullable<FoundationProspect['confidence']>, string> = {
  high: 'High confidence',
  medium: 'Some data',
  low: 'Limited data',
};

function scoreTone(score: number): 'success' | 'primary' | 'warning' | 'neutral' {
  if (score >= 70) return 'success';
  if (score >= 50) return 'primary';
  if (score >= 30) return 'warning';
  return 'neutral';
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toLocaleString()}`;
}

function FoundationProspectsRail({
  prospects,
  onWrite,
  disabled,
}: {
  prospects: FoundationProspect[];
  onWrite: (p: FoundationProspect) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<FoundationProspect | null>(null);
  const sorted = useMemo(
    () => [...prospects].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    [prospects],
  );
  const topScore = sorted[0]?.score ?? 0;

  return (
    <>
      <Card density="compact" className="bg-gradient-to-br from-violet-50/60 via-white to-emerald-50/40 border-violet-200/60">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-violet-100 p-2 text-violet-600 shrink-0">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle>Foundation prospects</CardTitle>
              <Badge tone="primary" soft>
                {sorted.length} 501(c)(3) funders
              </Badge>
              {topScore > 0 && (
                <Badge tone={scoreTone(topScore)} soft>
                  top fit {topScore}/100
                </Badge>
              )}
            </div>
            <CardDescription>
              Private education foundations ranked by{' '}
              <span className="font-medium text-claude-text">funder fit</span> —
              a deterministic blend of capacity, recent giving activity,
              recency, geography, focus, and grant-size fit, computed from
              public IRS Form 990 data. These are prospects (not RFPs):
              click any card for a deep analysis and an LOI playbook.
            </CardDescription>
          </div>
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {sorted.map((p) => {
            const score = p.score ?? 0;
            const conf = p.confidence ?? 'low';
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelected(p)}
                  className="group flex w-full items-start gap-3 rounded-lg border border-claude-border bg-white/80 p-3 text-left transition hover:border-violet-300 hover:shadow-c-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm font-medium text-claude-text truncate" title={p.name}>
                        {p.name}
                      </p>
                    </div>
                    <p className="text-xs text-claude-text-muted truncate">{p.focus}</p>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-claude-text-subtle flex-wrap">
                      {(p.city || p.state) && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {[p.city, p.state].filter(Boolean).join(', ')}
                        </span>
                      )}
                      <span className="tabular-nums">EIN {p.ein}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                      <Badge tone={scoreTone(score)} soft>
                        fit {score}/100
                      </Badge>
                      <Badge tone={CONFIDENCE_TONE_FOUNDATION[conf]} soft>
                        {CONFIDENCE_LABEL[conf]}
                      </Badge>
                      {p.financials?.grants_paid_annual_usd ? (
                        <Badge tone="neutral" soft>
                          ~{formatUsd(p.financials.grants_paid_annual_usd)}/yr
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-2.5">
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        trailingIcon={<ArrowRight className="h-3.5 w-3.5" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onWrite(p);
                        }}
                      >
                        Write a letter of inquiry
                      </Button>
                    </div>
                  </div>
                  <Sparkles className="h-3.5 w-3.5 text-violet-400 group-hover:text-violet-600 shrink-0 mt-0.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      {selected && (
        <FoundationDeepDive
          prospect={selected}
          onClose={() => setSelected(null)}
          onWrite={() => {
            const escolhida = selected;
            setSelected(null);
            onWrite(escolhida);
          }}
          disabled={disabled}
        />
      )}
    </>
  );
}

// ------------------------------------------------ foundation deep-dive

function FoundationDeepDive({
  prospect,
  onClose,
  onWrite,
  disabled,
}: {
  prospect: FoundationProspect;
  onClose: () => void;
  onWrite: () => void;
  disabled?: boolean;
}) {
  const score = prospect.score ?? 0;
  const conf = prospect.confidence ?? 'low';
  const f = prospect.financials ?? null;
  const brk = prospect.score_breakdown ?? null;
  const breakdownRows: Array<{ key: keyof FoundationScoreBreakdown; label: string; max: number; tip: string }> = [
    { key: 'capacity', label: 'Capacity', max: 25, tip: 'Asset size — bigger funder = bigger possible check.' },
    { key: 'activity', label: 'Recent giving', max: 20, tip: 'Are they actively writing checks?' },
    { key: 'recency', label: 'Filing recency', max: 10, tip: 'How fresh is the latest 990?' },
    { key: 'geographic_fit', label: 'Geographic fit', max: 20, tip: 'State / regional alignment with your school.' },
    { key: 'focus_fit', label: 'Focus fit', max: 15, tip: 'NTEE focus vs. your grant intent.' },
    { key: 'scale_fit', label: 'Grant-size fit', max: 10, tip: 'Typical grant matches what your school can absorb.' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-claude-text/30 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${prospect.name} — deep analysis`}
    >
      <motion.div
        initial={{ x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 32, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative w-full max-w-xl bg-white shadow-c-3 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* sticky header */}
        <div className="sticky top-0 z-10 bg-gradient-to-br from-violet-50 via-white to-emerald-50 border-b border-claude-border px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-violet-600 font-medium">
                Foundation prospect · deep analysis
              </p>
              <h3 className="mt-1 font-serif text-xl text-claude-text leading-tight">
                {prospect.name}
              </h3>
              <p className="mt-1 text-xs text-claude-text-muted">
                {prospect.focus}
                {(prospect.city || prospect.state) && (
                  <>
                    {' · '}
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {[prospect.city, prospect.state].filter(Boolean).join(', ')}
                    </span>
                  </>
                )}
                {' · '}
                <span className="tabular-nums">EIN {prospect.ein}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-claude-text-subtle hover:bg-white/60 hover:text-claude-text transition shrink-0"
              aria-label="Close deep analysis"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4">
            <Button
              onClick={onWrite}
              disabled={disabled}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            >
              Write a letter of inquiry
            </Button>
          </div>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <Badge tone={scoreTone(score)}>
              Funder fit {score}/100
            </Badge>
            <Badge tone={CONFIDENCE_TONE_FOUNDATION[conf]} soft>
              {CONFIDENCE_LABEL[conf]}
            </Badge>
            {f?.form_type && (
              <Badge tone="neutral" soft>
                Latest: {f.form_type} {f.latest_year ?? ''}
              </Badge>
            )}
            {f?.years_on_record ? (
              <Badge tone="neutral" soft>
                {f.years_on_record} filing{f.years_on_record === 1 ? '' : 's'} on file
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* score breakdown */}
          {brk && (
            <section>
              <h4 className="text-sm font-semibold text-claude-text mb-2 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                Why this score
              </h4>
              <ul className="space-y-2">
                {breakdownRows.map((row) => {
                  const v = brk[row.key] ?? 0;
                  return (
                    <li key={row.key}>
                      <div className="flex items-center justify-between text-xs text-claude-text-muted">
                        <span title={row.tip} className="cursor-help">
                          {row.label}
                        </span>
                        <span className="tabular-nums">
                          {v}/{row.max}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-claude-bg overflow-hidden">
                        <div
                          className="h-full bg-violet-500 rounded-full transition-[width] duration-500"
                          style={{ width: `${(v / row.max) * 100}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* financials */}
          <section>
            <h4 className="text-sm font-semibold text-claude-text mb-2">Latest IRS Form 990 snapshot</h4>
            {f && (f.total_assets_usd || f.total_revenue_usd || f.grants_paid_annual_usd) ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-claude-text-subtle">Total assets</dt>
                  <dd className="font-medium text-claude-text tabular-nums">{formatUsd(f.total_assets_usd)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-claude-text-subtle">Annual revenue</dt>
                  <dd className="font-medium text-claude-text tabular-nums">{formatUsd(f.total_revenue_usd)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-claude-text-subtle">Annual expenses</dt>
                  <dd className="font-medium text-claude-text tabular-nums">{formatUsd(f.total_expenses_usd)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-claude-text-subtle">Grants paid (annual)</dt>
                  <dd className="font-medium text-claude-text tabular-nums">{formatUsd(f.grants_paid_annual_usd)}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-xs text-claude-text-muted italic">
                ProPublica has no machine-readable financials on file for this funder.
                The IRS may still hold scanned filings — check ProPublica below.
              </p>
            )}
            {prospect.likely_give_range_usd && (
              <div className="mt-3 rounded-lg border border-violet-200/70 bg-violet-50/40 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-violet-700 font-medium">
                  Realistic ask range
                </p>
                <p className="mt-0.5 text-sm text-claude-text tabular-nums">
                  {formatUsd(prospect.likely_give_range_usd.low)} – {formatUsd(prospect.likely_give_range_usd.high)}
                </p>
                <p className="mt-0.5 text-[11px] text-claude-text-subtle italic">
                  Rough estimate based on typical 0.5–3% of annual giving.
                </p>
              </div>
            )}
          </section>

          {/* pros / cons / risks */}
          {(prospect.pros?.length || prospect.cons?.length || prospect.risk_flags?.length) ? (
            <section className="grid sm:grid-cols-2 gap-4">
              {prospect.pros && prospect.pros.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-emerald-700 mb-1.5 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Why pursue
                  </h4>
                  <ul className="space-y-1 text-xs text-claude-text-muted">
                    {prospect.pros.map((p, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-emerald-500 shrink-0">·</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {prospect.cons && prospect.cons.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-amber-700 mb-1.5 flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" />
                    Honest caveats
                  </h4>
                  <ul className="space-y-1 text-xs text-claude-text-muted">
                    {prospect.cons.map((c, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-amber-500 shrink-0">·</span>
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {prospect.risk_flags && prospect.risk_flags.length > 0 && (
                <div className="sm:col-span-2">
                  <h4 className="text-sm font-semibold text-rose-700 mb-1.5 flex items-center gap-1.5">
                    <XCircle className="h-3.5 w-3.5" />
                    Risk flags
                  </h4>
                  <ul className="space-y-1 text-xs text-claude-text-muted">
                    {prospect.risk_flags.map((r, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-rose-500 shrink-0">·</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          ) : null}

          {/* next step */}
          {prospect.recommended_next_step && (
            <section className="rounded-lg border border-claude-border bg-claude-bg/50 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-claude-text-subtle font-medium">
                Recommended next step
              </p>
              <p className="mt-1 text-sm text-claude-text leading-relaxed">
                {prospect.recommended_next_step}
              </p>
            </section>
          )}

          {/* external links */}
          <section className="flex flex-wrap gap-2 pt-2">
            <a
              href={prospect.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-claude-border bg-white px-3 py-1.5 text-xs font-medium text-claude-text hover:border-violet-300 hover:text-violet-700 transition"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              ProPublica profile
            </a>
            {f?.pdf_url && (
              <a
                href={f.pdf_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-claude-border bg-white px-3 py-1.5 text-xs font-medium text-claude-text hover:border-violet-300 hover:text-violet-700 transition"
              >
                <FileText className="h-3.5 w-3.5" />
                Latest Form 990 (PDF)
              </a>
            )}
          </section>

          <p className="text-[11px] text-claude-text-subtle italic pt-2 border-t border-claude-border">
            Source: ProPublica Nonprofit Explorer · IRS Form 990 public data.
            The funder-fit score is computed deterministically from the most
            recent filing; treat it as a prioritization aid, not a guarantee.
          </p>
        </div>
      </motion.div>
    </div>
  );
}


