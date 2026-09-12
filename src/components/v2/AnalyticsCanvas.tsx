'use client';

/**
 * Analytics canvas — live federal-funding-landscape view.
 *
 * Source of truth is ``GET /api/v2/analytics`` which proxies to the
 * Python backend's ``/v2/analytics/landscape`` endpoint. That endpoint
 * aggregates a fan-out of parallel queries to the public Grants.gov
 * ``search2`` Opportunities API, so every number on this page is real
 * and refreshes every ten minutes.
 *
 * The visual language mirrors the Hero / Results surfaces: serif H1,
 * Apple-blue accents, two-column "investor-deck" rhythm, motion on
 * value reveal.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  Calendar,
  ExternalLink,
  Landmark,
  MapPin,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { Card, CardTitle } from './Card';
import { Badge } from './Badge';
import { cn } from './cn';

interface LandscapePayload {
  as_of: string;
  source: string;
  sample_size: number;
  totals: {
    open_opportunities: number;
    closing_within_30_days: number;
    posted_last_30_days: number;
    unique_agencies_in_sample: number;
  };
  by_category: Array<{ key: string; label: string; count: number }>;
  by_agency: Array<{ name: string; count: number }>;
  closing_soon: Array<{
    title: string;
    agency: string;
    deadline: string;
    days_until: number;
    url: string;
    number: string;
  }>;
  posted_timeline: Array<{ week_start: string; count: number }>;
  foundation_universe?: {
    as_of: string;
    source: string;
    filters: string;
    totals: { active_us_education_foundations: number };
    by_state: Array<{ state: string; count: number }>;
    by_focus: Array<{ key: string; label: string; count: number }>;
    featured: Array<{
      ein: string;
      name: string;
      state: string;
      city: string;
      ntee_label: string;
      url: string;
    }>;
  };
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: LandscapePayload };

export function AnalyticsCanvas() {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  const load = async () => {
    setState({ status: 'loading' });
    try {
      const r = await fetch('/api/v2/analytics', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as LandscapePayload;
      if (!data || !data.totals) throw new Error('Invalid payload');
      setState({ status: 'ready', data });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to load analytics.',
      });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-10">
      <Header
        asOf={state.status === 'ready' ? state.data.as_of : null}
        source={state.status === 'ready' ? state.data.source : null}
        loading={state.status === 'loading'}
        onRefresh={load}
      />

      <AnimatePresence mode="wait">
        {state.status === 'loading' && <SkeletonView key="loading" />}
        {state.status === 'error' && (
          <ErrorView key="error" message={state.error} onRetry={load} />
        )}
        {state.status === 'ready' && (
          <motion.div
            key="ready"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
            className="space-y-10"
          >
            <StatGrid data={state.data} />
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <Card className="lg:col-span-3 overflow-hidden">
                <CategoryChart data={state.data.by_category} />
              </Card>
              <Card className="lg:col-span-2 overflow-hidden">
                <AgencyChart data={state.data.by_agency} />
              </Card>
            </div>
            <Card className="overflow-hidden">
              <ClosingSoonTable data={state.data.closing_soon} />
            </Card>
            <Card className="overflow-hidden">
              <PostedTimeline data={state.data.posted_timeline} />
            </Card>
            {state.data.foundation_universe && (
              <FoundationPanel data={state.data.foundation_universe} />
            )}
            <Footnote
              asOf={state.data.as_of}
              source={state.data.source}
              sampleSize={state.data.sample_size}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ----------------------------------------------------------- header & footer

function Header({
  asOf,
  source,
  loading,
  onRefresh,
}: {
  asOf: string | null;
  source: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div className="space-y-3">
        <Badge tone="primary" soft dot>
          Live federal funding landscape
        </Badge>
        <h2 className="font-serif text-h1 text-claude-text tracking-tight">
          What&apos;s open right now.
        </h2>
        <p className="text-claude-text-muted max-w-2xl text-[15px] leading-relaxed">
          Every figure on this page is queried directly from{' '}
          <span className="text-claude-text font-medium">
            {source ?? 'the Grants.gov Opportunities API'}
          </span>{' '}
          and refreshes every ten minutes — no demo numbers, no
          placeholders.
        </p>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className={cn(
          'inline-flex items-center gap-2 self-start sm:self-auto',
          'rounded-full border border-claude-border bg-white/70',
          'px-4 py-2 text-sm text-claude-text-muted',
          'hover:bg-white hover:text-claude-text transition',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        {loading ? 'Refreshing…' : asOf ? `Updated ${formatRelative(asOf)}` : 'Refresh'}
      </button>
    </header>
  );
}

function Footnote({
  asOf,
  source,
  sampleSize,
}: {
  asOf: string;
  source: string;
  sampleSize: number;
}) {
  return (
    <p className="text-[11px] text-claude-text-subtle leading-relaxed">
      Source: {source}. Open-opportunity total is the live{' '}
      <code className="px-1 py-0.5 rounded bg-claude-bg-subtle text-[10px]">
        hitCount
      </code>{' '}
      returned by the API; agency and closing-soon breakdowns are computed
      from a representative {sampleSize}-opportunity recent sample. Snapshot
      taken {new Date(asOf).toLocaleString('en-US')}.
    </p>
  );
}

// ----------------------------------------------------------- stat grid

function StatGrid({ data }: { data: LandscapePayload }) {
  const items: Array<{
    label: string;
    value: number | string;
    suffix?: string;
    caption: string;
    icon: React.ReactNode;
  }> = [
    {
      label: 'Open opportunities',
      value: data.totals.open_opportunities,
      caption: 'Total federal grants currently accepting applications',
      icon: <Sparkles className="h-4 w-4" />,
    },
    {
      label: 'Closing within 30 days',
      value: data.totals.closing_within_30_days,
      caption: 'Deadlines pressing in the next month',
      icon: <AlertTriangle className="h-4 w-4" />,
    },
    {
      label: 'Posted in the last 30 days',
      value: data.totals.posted_last_30_days,
      caption: 'Fresh opportunities since this time last month',
      icon: <TrendingUp className="h-4 w-4" />,
    },
    {
      label: 'Active funding agencies',
      value: data.totals.unique_agencies_in_sample,
      caption: 'Distinct federal funders in the latest sample',
      icon: <Landmark className="h-4 w-4" />,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {items.map((it, i) => (
        <motion.div
          key={it.label}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: i * 0.05, ease: [0.2, 0.7, 0.2, 1] }}
        >
          <Card density="compact" className="relative h-full">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-claude-text-subtle uppercase tracking-wider">
                {it.label}
              </span>
              <span className="text-claude-primary/70">{it.icon}</span>
            </div>
            <p className="mt-4 font-serif text-4xl text-claude-text tabular-nums leading-none">
              <Counter value={Number(it.value)} />
            </p>
            <p className="mt-2 text-xs text-claude-text-muted leading-snug">
              {it.caption}
            </p>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

/** Animated count-up — 600 ms ease-out from 0 to target. */
function Counter({ value }: { value: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const duration = 700;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setN(Math.round(value * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n.toLocaleString('en-US')}</>;
}

// ----------------------------------------------------------- category chart

function CategoryChart({
  data,
}: {
  data: LandscapePayload['by_category'];
}) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <CardTitle>Open opportunities by focus area</CardTitle>
        <Badge soft>Live</Badge>
      </div>
      <ul className="space-y-4">
        {data.map((d, i) => {
          const pct = (d.count / max) * 100;
          return (
            <li
              key={d.key}
              className="grid grid-cols-[140px_1fr_64px] items-center gap-4"
            >
              <span className="text-sm text-claude-text font-medium">
                {d.label}
              </span>
              <div className="relative h-2.5 rounded-full bg-claude-accent-muted/60 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{
                    duration: 0.7,
                    delay: i * 0.06,
                    ease: [0.2, 0.7, 0.2, 1],
                  }}
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-claude-primary to-claude-primary/70"
                />
              </div>
              <span className="text-sm text-claude-text tabular-nums text-right font-medium">
                {d.count.toLocaleString('en-US')}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ----------------------------------------------------------- agency chart

function AgencyChart({ data }: { data: LandscapePayload['by_agency'] }) {
  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <CardTitle>Top funders in sample</CardTitle>
        <Badge soft>Live</Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">
          No identifiable agencies in the current sample.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.map((a, i) => (
            <motion.li
              key={a.name}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="flex items-start gap-3"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-claude-primary/10 text-claude-primary text-xs font-bold tabular-nums">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-claude-text font-medium leading-snug truncate">
                  {a.name}
                </p>
                <p className="text-xs text-claude-text-subtle tabular-nums">
                  {a.count} opportunit{a.count === 1 ? 'y' : 'ies'}
                </p>
              </div>
            </motion.li>
          ))}
        </ul>
      )}
    </>
  );
}

// ----------------------------------------------------------- closing-soon

function ClosingSoonTable({
  data,
}: {
  data: LandscapePayload['closing_soon'];
}) {
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>Closing soonest</CardTitle>
        <Badge tone="primary" soft>
          Next 30 days
        </Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">
          Nothing closes in the next 30 days. Plenty of breathing room.
        </p>
      ) : (
        <ul className="divide-y divide-claude-border">
          {data.map((g, i) => (
            <motion.li
              key={`${g.number}-${i}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: i * 0.04 }}
              className="py-4 grid grid-cols-[72px_1fr_auto] items-start gap-4"
            >
              <DeadlinePill days={g.days_until} />
              <div className="min-w-0">
                <p className="text-sm text-claude-text font-medium leading-snug">
                  {g.title}
                </p>
                <p className="mt-1 text-xs text-claude-text-muted flex items-center gap-2">
                  <Calendar className="h-3 w-3" />
                  {formatLongDate(g.deadline)} · {g.agency}
                </p>
              </div>
              <a
                href={g.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-claude-primary hover:text-claude-primary-hover whitespace-nowrap pt-0.5"
              >
                Open
                <ExternalLink className="h-3 w-3" />
              </a>
            </motion.li>
          ))}
        </ul>
      )}
    </>
  );
}

function DeadlinePill({ days }: { days: number }) {
  const urgent = days <= 7;
  const soon = days <= 14;
  const tone = urgent
    ? 'bg-rose-50 text-rose-700 border-rose-200'
    : soon
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-claude-primary/8 text-claude-primary border-claude-primary/20';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border px-2 py-1.5 tabular-nums',
        tone,
      )}
    >
      <span className="font-serif text-xl leading-none">{days}</span>
      <span className="text-[9px] font-bold uppercase tracking-wider mt-0.5">
        {days === 1 ? 'day' : 'days'}
      </span>
    </div>
  );
}

// ----------------------------------------------------------- timeline

function PostedTimeline({
  data,
}: {
  data: LandscapePayload['posted_timeline'];
}) {
  const w = 720;
  const h = 140;
  const padX = 8;
  const padY = 16;
  const max = Math.max(...data.map((d) => d.count), 1);
  const stepX = (w - padX * 2) / Math.max(1, data.length - 1);

  const points = data.map((d, i) => {
    const x = padX + i * stepX;
    const y = padY + (1 - d.count / max) * (h - padY * 2);
    return { x, y, d };
  });

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L ${points[points.length - 1].x.toFixed(1)} ${h - padY} L ${points[0].x.toFixed(1)} ${h - padY} Z`;

  const total = data.reduce((acc, d) => acc + d.count, 0);
  const recent = data.slice(-4).reduce((acc, d) => acc + d.count, 0);
  const earlier = data.slice(0, 4).reduce((acc, d) => acc + d.count, 0);
  const trendPct = earlier === 0 ? 0 : Math.round(((recent - earlier) / earlier) * 100);

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <div>
          <CardTitle>New postings · last 12 weeks</CardTitle>
          <p className="mt-1 text-xs text-claude-text-muted">
            {total.toLocaleString('en-US')} opportunities posted across the
            window
            {trendPct !== 0 && (
              <>
                {' '}
                ·{' '}
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 font-medium',
                    trendPct > 0 ? 'text-emerald-600' : 'text-rose-600',
                  )}
                >
                  <ArrowUpRight
                    className={cn(
                      'h-3 w-3',
                      trendPct < 0 && 'rotate-90',
                    )}
                  />
                  {trendPct > 0 ? '+' : ''}
                  {trendPct}% recent vs. earlier
                </span>
              </>
            )}
          </p>
        </div>
        <Badge soft>Weekly</Badge>
      </div>
      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-36"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="sg-tl" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(46 124 228)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="rgb(46 124 228)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Grid baseline. */}
          <line
            x1={padX}
            y1={h - padY}
            x2={w - padX}
            y2={h - padY}
            stroke="rgb(220 229 240)"
            strokeWidth="0.6"
          />
          <motion.path
            d={area}
            fill="url(#sg-tl)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          />
          <motion.path
            d={line}
            fill="none"
            stroke="rgb(46 124 228)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
          />
          {points.map((p, i) => (
            <g key={i}>
              <motion.circle
                cx={p.x}
                cy={p.y}
                r={2.5}
                fill="rgb(46 124 228)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4, delay: 0.5 + i * 0.03 }}
              />
            </g>
          ))}
        </svg>
        <div className="mt-2 flex items-center justify-between text-[10px] text-claude-text-subtle tabular-nums">
          <span>{formatShortDate(data[0]?.week_start)}</span>
          <span>{formatShortDate(data[data.length - 1]?.week_start)}</span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------- foundation panel

function FoundationPanel({
  data,
}: {
  data: NonNullable<LandscapePayload['foundation_universe']>;
}) {
  const total = data.totals.active_us_education_foundations;
  // ProPublica's index caps total_results at 10,000 — show "10,000+"
  // when we hit the ceiling so the number reads honestly.
  const totalDisplay =
    total >= 10_000 ? '10,000+' : total.toLocaleString('en-US');
  const focusMax = Math.max(1, ...data.by_focus.map((f) => f.count));
  const stateMax = Math.max(1, ...data.by_state.map((s) => s.count));

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
      className="space-y-6"
    >
      {/* Hero card with the universe headline */}
      <Card className="relative overflow-hidden">
        <div className="absolute -top-32 -right-24 w-96 h-96 rounded-full bg-gradient-to-br from-violet-400/20 via-claude-primary/20 to-transparent blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -left-24 w-96 h-96 rounded-full bg-gradient-to-tr from-emerald-400/15 via-claude-primary/10 to-transparent blur-3xl pointer-events-none" />
        <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-5 space-y-3">
            <Badge tone="primary" soft dot>
              Foundation universe · ProPublica
            </Badge>
            <h3 className="font-serif text-3xl sm:text-4xl text-claude-text tracking-tight leading-tight">
              {totalDisplay} U.S. education foundations.
            </h3>
            <p className="text-claude-text-muted text-[15px] leading-relaxed">
              Beyond federal grants, hundreds of private 501(c)(3)
              education funders publish their giving in Form 990 filings.
              Every name on this page is sourced live from the ProPublica
              Nonprofit Explorer. Each one is a real prospect.
            </p>
            <p className="text-[11px] text-claude-text-subtle">
              Filters: {data.filters}.
            </p>
          </div>
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FoundationStat
              icon={<Building2 className="h-4 w-4" />}
              label="Active 501(c)(3) education funders"
              value={totalDisplay}
              accent="violet"
            />
            <FoundationStat
              icon={<MapPin className="h-4 w-4" />}
              label="States with ≥ 500 foundations"
              value={data.by_state
                .filter((s) => s.count >= 500)
                .length.toString()}
              accent="blue"
            />
            <FoundationStat
              icon={<Sparkles className="h-4 w-4" />}
              label="Distinct focus segments charted"
              value={data.by_focus.length.toString()}
              accent="amber"
            />
            <FoundationStat
              icon={<Landmark className="h-4 w-4" />}
              label="Featured prospects below"
              value={data.featured.length.toString()}
              accent="emerald"
            />
          </div>
        </div>
      </Card>

      {/* Geography + Focus */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-2 overflow-hidden">
          <CardTitle
            eyebrow="By state"
            title="Where the foundations are"
            description="Top 12 U.S. states by active education foundations"
          />
          <ul className="mt-5 space-y-3">
            {data.by_state.slice(0, 8).map((s, i) => (
              <li key={s.state} className="flex items-center gap-3">
                <span className="text-[11px] tabular-nums text-claude-text-subtle w-5">
                  {i + 1}
                </span>
                <span className="text-sm font-medium text-claude-text w-10">
                  {s.state}
                </span>
                <div className="flex-1 h-2 bg-claude-bg-subtle rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{
                      width: `${Math.max(4, (s.count / stateMax) * 100)}%`,
                    }}
                    transition={{
                      duration: 0.7,
                      delay: 0.04 * i,
                      ease: [0.2, 0.7, 0.2, 1],
                    }}
                    className="h-full bg-gradient-to-r from-violet-400 to-claude-primary"
                  />
                </div>
                <span className="text-sm tabular-nums text-claude-text-muted w-16 text-right">
                  {s.count.toLocaleString('en-US')}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-3 overflow-hidden">
          <CardTitle
            eyebrow="By focus"
            title="What they fund"
            description="Indexed by foundation name + mission keywords (NTEE Group B)"
          />
          <ul className="mt-5 space-y-4">
            {data.by_focus.map((f, i) => (
              <li key={f.key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-claude-text font-medium">
                    {f.label}
                  </span>
                  <span className="text-sm tabular-nums text-claude-text-muted">
                    {f.count.toLocaleString('en-US')}
                    <span className="text-[11px] text-claude-text-subtle ml-1">
                      orgs
                    </span>
                  </span>
                </div>
                <div className="h-2 bg-claude-bg-subtle rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{
                      width: `${Math.max(3, (f.count / focusMax) * 100)}%`,
                    }}
                    transition={{
                      duration: 0.7,
                      delay: 0.05 * i,
                      ease: [0.2, 0.7, 0.2, 1],
                    }}
                    className="h-full bg-gradient-to-r from-claude-primary to-emerald-400"
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Featured prospects */}
      <Card className="overflow-hidden">
        <CardTitle
          eyebrow="Featured prospects"
          title="Real foundations, surfaced live"
          description="A live sample from ProPublica. Click any name to see the foundation's 990 history."
        />
        <ul className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          {data.featured.map((f) => (
            <li key={f.ein}>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="group block rounded-2xl border border-claude-border bg-white/60 px-4 py-3 hover:bg-white hover:border-claude-primary/40 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-claude-text truncate">
                      {f.name}
                    </p>
                    <p className="text-[11px] text-claude-text-subtle mt-0.5 truncate">
                      {f.ntee_label}
                      {f.city || f.state
                        ? ` · ${[f.city, f.state].filter(Boolean).join(', ')}`
                        : ''}
                      {' · EIN '}
                      {f.ein.slice(0, 2)}-{f.ein.slice(2)}
                    </p>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 text-claude-text-subtle group-hover:text-claude-primary flex-shrink-0 mt-0.5" />
                </div>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </motion.div>
  );
}

function FoundationStat({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: 'violet' | 'blue' | 'amber' | 'emerald';
}) {
  const ring =
    accent === 'violet'
      ? 'from-violet-400/30 to-violet-400/0'
      : accent === 'blue'
        ? 'from-claude-primary/30 to-claude-primary/0'
        : accent === 'amber'
          ? 'from-amber-400/30 to-amber-400/0'
          : 'from-emerald-400/30 to-emerald-400/0';
  return (
    <div className="relative rounded-2xl border border-claude-border bg-white/60 px-4 py-3 overflow-hidden">
      <div
        className={cn(
          'absolute -top-8 -right-8 w-24 h-24 rounded-full bg-gradient-to-br blur-2xl',
          ring,
        )}
      />
      <div className="relative">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-claude-text-subtle">
          {icon}
          <span>{label}</span>
        </div>
        <p className="mt-2 font-serif text-2xl text-claude-text tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- skeleton & error

function SkeletonView() {
  return (
    <motion.div
      key="loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="space-y-10"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} density="compact">
            <div className="h-3 w-24 bg-claude-bg-subtle rounded mb-4 animate-pulse" />
            <div className="h-9 w-20 bg-claude-bg-subtle rounded mb-3 animate-pulse" />
            <div className="h-3 w-40 bg-claude-bg-subtle rounded animate-pulse" />
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 h-72 animate-pulse" />
        <Card className="lg:col-span-2 h-72 animate-pulse" />
      </div>
      <Card className="h-64 animate-pulse" />
      <Card className="h-44 animate-pulse" />
    </motion.div>
  );
}

function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <motion.div
      key="error"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <Card className="p-8 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto mb-3" />
        <p className="text-claude-text font-medium">
          The analytics service did not respond.
        </p>
        <p className="text-sm text-claude-text-muted mt-1">{message}</p>
        <button
          onClick={onRetry}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-claude-primary px-4 py-2 text-sm text-white hover:bg-claude-primary-hover transition"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </button>
      </Card>
    </motion.div>
  );
}

// ----------------------------------------------------------- formatting

function formatLongDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatShortDate(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const ms = Date.now() - then;
    const min = Math.round(ms / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const day = Math.round(hr / 24);
    return `${day} day${day === 1 ? '' : 's'} ago`;
  } catch {
    return iso;
  }
}
