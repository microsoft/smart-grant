'use client';

/**
 * Pulse — the portal's heartbeat.
 *
 * Renders live portal-usage analytics from ``GET /api/v2/analytics/pulse``:
 * what sectors people are exploring, which states they're writing for,
 * which funders they're targeting, and a live activity feed.
 *
 * Todo número desta página obedece à mesma janela — a que o usuário escolhe
 * no seletor. Ela é declarada uma vez, junto com o intervalo que os dados
 * realmente cobrem, em vez de repetida (e divergente) card a card.
 *
 * Visual personality is intentionally distinct from the Landscape tab:
 * a warm amber/blue dual-accent, a heartbeat-style activity ribbon,
 * and a live feed that scrolls like a newsroom ticker — while still
 * sharing the Apple-blue base palette, serif H1s, tabular numbers,
 * and Framer Motion staggered reveals.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Compass,
  DollarSign,
  FileText,
  MapPin,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Users,
} from 'lucide-react';
import { Card, CardTitle } from './Card';
import { Badge } from './Badge';
import { cn } from './cn';

type WindowKey = '7' | '30' | '90' | '365' | 'all';

const WINDOWS: ReadonlyArray<{ key: WindowKey; short: string; label: string }> = [
  { key: '7', short: '7d', label: 'Last 7 days' },
  { key: '30', short: '30d', label: 'Last 30 days' },
  { key: '90', short: '90d', label: 'Last 90 days' },
  { key: '365', short: '1y', label: 'Last 12 months' },
  { key: 'all', short: 'All', label: 'All time' },
];

const BUCKET_LABEL: Record<string, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
};

interface PulsePayload {
  as_of: string;
  window: {
    days: number | null;
    from: string | null;
    to: string | null;
  };
  totals: {
    agent_runs: number;
    applications_drafted: number;
    schools_served: number;
    funding_explored_usd: number;
    conversion_pct: number;
    avg_award_ceiling_usd: number;
  };
  by_sector: Array<{ key: string; label: string; count: number }>;
  by_state: Array<{ state: string; count: number }>;
  by_school_type: Array<{ label: string; count: number }>;
  top_schools: Array<{ name: string; count: number; state: string | null }>;
  top_funders: Array<{ name: string; count: number }>;
  activity: {
    bucket: string;
    points: Array<{ date: string; discoveries: number; generations: number }>;
  };
  recent_activity: Array<{
    ts: string;
    event_type: string;
    sector: string;
    school_name: string | null;
    state: string | null;
    selected_grant_title: string | null;
    selected_funder: string | null;
  }>;
  provenance: {
    storage_configured: boolean;
    events_in_window: number;
    history_started_on: string | null;
    unreadable_lines: number;
    source: string;
  };
}

export function PulseCanvas() {
  const [windowKey, setWindowKey] = useState<WindowKey>('30');
  const [data, setData] = useState<PulsePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  // Trocar de janela depressa dispara varias buscas. Sem cancelar a anterior,
  // uma resposta atrasada pode chegar depois e pintar o painel com os numeros
  // de uma janela que o usuario ja abandonou.
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async (key: WindowKey) => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setBusy(true);
    try {
      const r = await fetch(`/api/v2/analytics/pulse?window=${key}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const payload = (await r.json()) as PulsePayload;
      if (!payload?.totals || !payload?.window) throw new Error('Invalid payload');
      setData(payload);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(
        err instanceof Error ? err.message : 'Failed to load portal pulse.',
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(windowKey);
    return () => inFlight.current?.abort();
  }, [load, windowKey]);

  const showSkeleton = busy && !data;
  const showError = !!error && !data;

  return (
    <div className="space-y-10">
      <Header
        asOf={data?.as_of ?? null}
        busy={busy}
        staleError={data ? error : null}
        onRefresh={() => void load(windowKey)}
      />

      <WindowPicker value={windowKey} onChange={setWindowKey} range={data?.window ?? null} />

      <AnimatePresence mode="wait">
        {showSkeleton && <SkeletonView key="loading" />}
        {showError && (
          <ErrorView key="error" message={error!} onRetry={() => void load(windowKey)} />
        )}
        {data && !showError && (
          <motion.div
            key="body"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
            // Durante uma troca de janela o conteudo anterior fica no lugar,
            // apenas recuado. Trocar tudo por um esqueleto faria a pagina
            // piscar a cada clique.
            className={cn(
              'space-y-10 transition-opacity duration-200',
              busy && 'opacity-60',
            )}
          >
            <PulseBody data={data} onSelectWindow={setWindowKey} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Escolhe entre o painel completo e os tres estados vazios honestos. */
function PulseBody({
  data,
  onSelectWindow,
}: {
  data: PulsePayload;
  onSelectWindow: (key: WindowKey) => void;
}) {
  if (!data.provenance.storage_configured) {
    return <UnconfiguredView asOf={data.as_of} />;
  }
  if (!data.provenance.history_started_on) {
    return <EmptyView asOf={data.as_of} />;
  }
  if (data.totals.agent_runs === 0) {
    return (
      <QuietWindowView
        since={data.provenance.history_started_on}
        onShowEverything={() => onSelectWindow('all')}
      />
    );
  }

  return (
    <>
      <StatGrid data={data} />

      <Card className="overflow-hidden">
        <ActivityRibbon data={data} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 overflow-hidden">
          <SectorMix data={data.by_sector} />
        </Card>
        <Card className="lg:col-span-2 overflow-hidden">
          <SchoolTypeMix data={data.by_school_type} />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-2 overflow-hidden">
          <StatesPanel data={data.by_state} />
        </Card>
        <Card className="lg:col-span-3 overflow-hidden">
          <TopFunders data={data.top_funders} />
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 overflow-hidden">
          <TopSchools data={data.top_schools} />
        </Card>
        <Card className="lg:col-span-2 overflow-hidden">
          <RecentFeed data={data.recent_activity} />
        </Card>
      </div>

      <Footnote provenance={data.provenance} asOf={data.as_of} />
    </>
  );
}

// ----------------------------------------------------------------- header

function Header({
  asOf,
  busy,
  staleError,
  onRefresh,
}: {
  asOf: string | null;
  busy: boolean;
  staleError: string | null;
  onRefresh: () => void;
}) {
  return (
    <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div className="space-y-3">
        <Badge tone="primary" soft dot>
          Pulse · The portal&apos;s heartbeat
        </Badge>
        <h2 className="font-serif text-h1 text-claude-text tracking-tight">
          Who&apos;s writing, where, for what.
        </h2>
        <p className="text-claude-text-muted max-w-2xl text-[15px] leading-relaxed">
          A live look at the people using Smart Grant Request — the
          sectors they&apos;re exploring, the states they&apos;re writing
          from, the funders they&apos;re aiming at, and the dollars they
          could unlock.
        </p>
      </div>
      <div className="flex flex-col items-start sm:items-end gap-1.5">
        <button
          onClick={onRefresh}
          disabled={busy}
          className={cn(
            'inline-flex items-center gap-2 whitespace-nowrap',
            'rounded-full border border-claude-border bg-white/70',
            'px-4 py-2 text-sm text-claude-text-muted',
            'hover:bg-white hover:text-claude-text transition',
            'disabled:opacity-60 disabled:cursor-not-allowed',
          )}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
          {busy
            ? 'Refreshing…'
            : asOf
              ? `Updated ${formatRelative(asOf)}`
              : 'Refresh'}
        </button>
        {/* Uma atualizacao que falha com dados na tela nao pode apagar a tela;
            mas tambem nao pode fingir que os numeros sao recentes. */}
        {staleError && (
          <span className="text-[11px] text-amber-700">
            Showing the last successful snapshot · {staleError}
          </span>
        )}
      </div>
    </header>
  );
}

// ----------------------------------------------------------------- window

function WindowPicker({
  value,
  onChange,
  range,
}: {
  value: WindowKey;
  onChange: (key: WindowKey) => void;
  range: PulsePayload['window'] | null;
}) {
  const reduceMotion = useReducedMotion();
  const active = WINDOWS.find((w) => w.key === value) ?? WINDOWS[1];

  // Setas movem a selecao, como num segmented control nativo.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const index = WINDOWS.findIndex((w) => w.key === value);
    const next = (index + delta + WINDOWS.length) % WINDOWS.length;
    onChange(WINDOWS[next].key);
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div
        role="radiogroup"
        aria-label="Reporting period"
        onKeyDown={onKeyDown}
        className="inline-flex items-center gap-1 rounded-full border border-claude-border bg-white/70 p-1"
      >
        {WINDOWS.map((w) => {
          const selected = w.key === value;
          return (
            <button
              key={w.key}
              role="radio"
              aria-checked={selected}
              aria-label={w.label}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(w.key)}
              className={cn(
                'relative rounded-full px-3.5 py-1.5 text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2',
                'focus-visible:ring-claude-primary/40',
                selected
                  ? 'text-white'
                  : 'text-claude-text-muted hover:text-claude-text',
              )}
            >
              {selected && (
                <motion.span
                  layoutId="pulse-window-pill"
                  className="absolute inset-0 rounded-full bg-claude-primary"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 420, damping: 34 }
                  }
                />
              )}
              <span className="relative tabular-nums">{w.short}</span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-claude-text-subtle">
        <span className="text-claude-text-muted font-medium">{active.label}</span>
        {range?.from && range?.to && (
          <>
            {' · covering '}
            {formatShortDate(range.from)} – {formatShortDate(range.to)}
          </>
        )}
      </p>
    </div>
  );
}

function Footnote({
  provenance,
  asOf,
}: {
  provenance: PulsePayload['provenance'];
  asOf: string;
}) {
  return (
    <p className="text-[11px] text-claude-text-subtle leading-relaxed">
      {provenance.source} {provenance.events_in_window.toLocaleString('en-US')}{' '}
      {provenance.events_in_window === 1 ? 'event' : 'events'} in this window
      {provenance.history_started_on && (
        <> · recording since {formatShortDate(provenance.history_started_on)}</>
      )}
      {/* Linha ilegivel some da agregacao de qualquer jeito; some declarada. */}
      {provenance.unreadable_lines > 0 && (
        <>
          {' '}
          · {provenance.unreadable_lines.toLocaleString('en-US')} unreadable{' '}
          {provenance.unreadable_lines === 1 ? 'line' : 'lines'} skipped
        </>
      )}
      . Snapshot taken {new Date(asOf).toLocaleString('en-US')}.
    </p>
  );
}

// ----------------------------------------------------------------- stats

function StatGrid({ data }: { data: PulsePayload }) {
  // A janela e declarada uma vez, ao lado do seletor. Repeti-la em cada card
  // era o que deixava passar batido que "Funding explored" seguia outra.
  const drafts = data.totals.applications_drafted;
  const discoveries = data.totals.agent_runs - drafts;

  const items: Array<{
    label: string;
    value: number;
    formatter: (n: number) => string;
    caption: string;
    icon: React.ReactNode;
    accent: 'blue' | 'amber' | 'emerald' | 'violet';
  }> = [
    {
      label: 'Agent runs',
      value: data.totals.agent_runs,
      formatter: (n) => n.toLocaleString('en-US'),
      caption: `${discoveries.toLocaleString('en-US')} discoveries · ${drafts.toLocaleString('en-US')} drafts`,
      icon: <Users className="h-4 w-4" />,
      accent: 'blue',
    },
    {
      label: 'Applications drafted',
      value: drafts,
      formatter: (n) => n.toLocaleString('en-US'),
      caption: `${data.totals.conversion_pct}% of discoveries converted to drafts`,
      icon: <FileText className="h-4 w-4" />,
      accent: 'amber',
    },
    {
      label: 'Schools served',
      value: data.totals.schools_served,
      formatter: (n) => n.toLocaleString('en-US'),
      caption: 'Distinct schools in this period',
      icon: <Building2 className="h-4 w-4" />,
      accent: 'emerald',
    },
    {
      label: 'Funding explored',
      value: data.totals.funding_explored_usd,
      formatter: formatBigUsd,
      caption: `Avg award ceiling ${formatBigUsd(data.totals.avg_award_ceiling_usd)}`,
      icon: <DollarSign className="h-4 w-4" />,
      accent: 'violet',
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
          <Card density="compact" className="relative h-full overflow-hidden">
            {/* Soft accent gradient corner */}
            <div
              className={cn(
                'pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full opacity-60',
                accentBlob(it.accent),
              )}
            />
            <div className="relative flex items-center justify-between">
              <span className="text-[11px] font-medium text-claude-text-subtle uppercase tracking-wider">
                {it.label}
              </span>
              <span className={cn('rounded-full p-1.5', accentChip(it.accent))}>
                {it.icon}
              </span>
            </div>
            <p className="relative mt-4 font-serif text-4xl text-claude-text tabular-nums leading-none">
              <Counter value={it.value} formatter={it.formatter} />
            </p>
            <p className="relative mt-2 text-xs text-claude-text-muted leading-snug">
              {it.caption}
            </p>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

function accentBlob(accent: 'blue' | 'amber' | 'emerald' | 'violet'): string {
  switch (accent) {
    case 'blue':
      return 'bg-gradient-to-br from-claude-primary/25 to-transparent';
    case 'amber':
      return 'bg-gradient-to-br from-amber-300/35 to-transparent';
    case 'emerald':
      return 'bg-gradient-to-br from-emerald-300/30 to-transparent';
    case 'violet':
      return 'bg-gradient-to-br from-violet-300/35 to-transparent';
  }
}

function accentChip(accent: 'blue' | 'amber' | 'emerald' | 'violet'): string {
  switch (accent) {
    case 'blue':
      return 'bg-claude-primary/10 text-claude-primary';
    case 'amber':
      return 'bg-amber-100 text-amber-700';
    case 'emerald':
      return 'bg-emerald-100 text-emerald-700';
    case 'violet':
      return 'bg-violet-100 text-violet-700';
  }
}

/** Animated count-up. Supports a custom formatter for $ display. */
function Counter({
  value,
  formatter,
}: {
  value: number;
  formatter?: (n: number) => string;
}) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const duration = 800;
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
  return <>{formatter ? formatter(n) : n.toLocaleString('en-US')}</>;
}

// ------------------------------------------------------------- activity ribbon

function ActivityRibbon({ data }: { data: PulsePayload }) {
  const points = data.activity.points;
  const bucket = data.activity.bucket;
  const total = points.reduce((acc, p) => acc + p.discoveries + p.generations, 0);

  // Uma janela pode caber num unico balde (um mes de historico em "All time").
  // Uma linha precisa de dois pontos; com um so, o SVG sairia vazio e pareceria
  // um bug. Mostramos os numeros.
  if (points.length < 2) {
    return (
      <>
        <RibbonHeading bucket={bucket} total={total} />
        <div className="flex items-center gap-8 py-6">
          <SingleBucketFigure
            value={points[0]?.discoveries ?? 0}
            label="Discoveries"
            className="text-claude-primary"
          />
          <SingleBucketFigure
            value={points[0]?.generations ?? 0}
            label="Drafts"
            className="text-amber-600"
          />
          <span className="text-xs text-claude-text-subtle">
            {formatBucketDate(points[0]?.date, bucket)}
          </span>
        </div>
      </>
    );
  }

  const w = 720;
  const h = 160;
  const padX = 8;
  const padY = 14;
  const max = Math.max(
    1,
    ...points.map((p) => p.discoveries + p.generations),
  );
  const stepX = (w - padX * 2) / Math.max(1, points.length - 1);

  const xy = (i: number, v: number) => ({
    x: padX + i * stepX,
    y: padY + (1 - v / max) * (h - padY * 2),
  });

  const disPts = points.map((p, i) => xy(i, p.discoveries));
  const genPts = points.map((p, i) => xy(i, p.generations));

  const path = (pts: typeof disPts) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

  const disLine = path(disPts);
  const genLine = path(genPts);

  const disArea = `${disLine} L ${disPts[disPts.length - 1].x.toFixed(1)} ${h - padY} L ${disPts[0].x.toFixed(1)} ${h - padY} Z`;
  const genArea = `${genLine} L ${genPts[genPts.length - 1].x.toFixed(1)} ${h - padY} L ${genPts[0].x.toFixed(1)} ${h - padY} Z`;

  return (
    <>
      <RibbonHeading bucket={bucket} total={total} />
      <div className="w-full">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40" preserveAspectRatio="none">
          <defs>
            <linearGradient id="pulse-dis" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(46 124 228)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="rgb(46 124 228)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="pulse-gen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(245 158 11)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="rgb(245 158 11)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line
            x1={padX}
            y1={h - padY}
            x2={w - padX}
            y2={h - padY}
            stroke="rgb(220 229 240)"
            strokeWidth="0.6"
          />
          <motion.path
            d={disArea}
            fill="url(#pulse-dis)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7 }}
          />
          <motion.path
            d={genArea}
            fill="url(#pulse-gen)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.2 }}
          />
          <motion.path
            d={disLine}
            fill="none"
            stroke="rgb(46 124 228)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.0, ease: [0.2, 0.7, 0.2, 1] }}
          />
          <motion.path
            d={genLine}
            fill="none"
            stroke="rgb(245 158 11)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.0, delay: 0.15, ease: [0.2, 0.7, 0.2, 1] }}
          />
        </svg>
        <div className="mt-2 flex items-center justify-between text-[10px] text-claude-text-subtle tabular-nums">
          <span>{formatBucketDate(points[0]?.date, bucket)}</span>
          <span>{formatBucketDate(points[points.length - 1]?.date, bucket)}</span>
        </div>
      </div>
    </>
  );
}

function RibbonHeading({ bucket, total }: { bucket: string; total: number }) {
  return (
    <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
      <div>
        <CardTitle>Activity heartbeat</CardTitle>
        <p className="mt-1 text-xs text-claude-text-muted">
          {total.toLocaleString('en-US')} agent {total === 1 ? 'run' : 'runs'} ·{' '}
          <span className="inline-flex items-center gap-1 text-claude-primary font-medium">
            <span className="inline-block h-2 w-2 rounded-full bg-claude-primary" />
            Discoveries
          </span>
          {'  '}
          <span className="inline-flex items-center gap-1 text-amber-700 font-medium ml-3">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
            Drafts
          </span>
        </p>
      </div>
      {/* O balde vem do backend: o rotulo nunca pode desmentir o grafico. */}
      <Badge soft>{BUCKET_LABEL[bucket] ?? bucket}</Badge>
    </div>
  );
}

function SingleBucketFigure({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className: string;
}) {
  return (
    <div>
      <div className={cn('font-serif text-4xl tabular-nums', className)}>
        {value.toLocaleString('en-US')}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-claude-text-subtle">
        {label}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- sector mix

function SectorMix({
  data,
}: {
  data: PulsePayload['by_sector'];
}) {
  const total = data.reduce((acc, d) => acc + d.count, 0);
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>What people are exploring</CardTitle>
        <Badge soft>
          <Compass className="h-3 w-3 mr-1 inline" />
          {data.length} sectors
        </Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">
          No sector activity recorded yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {data.map((d, i) => {
            const pct = (d.count / max) * 100;
            const share = total > 0 ? Math.round((100 * d.count) / total) : 0;
            return (
              <li
                key={d.key}
                className="grid grid-cols-[170px_1fr_88px] items-center gap-4"
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
                  <span className="ml-1 text-claude-text-subtle text-xs">
                    · {share}%
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ----------------------------------------------------------------- school type

function SchoolTypeMix({
  data,
}: {
  data: PulsePayload['by_school_type'];
}) {
  const total = data.reduce((acc, d) => acc + d.count, 0);
  // Build a stacked horizontal bar.
  const COLORS = ['rgb(46 124 228)', 'rgb(245 158 11)', 'rgb(16 185 129)', 'rgb(139 92 246)'];
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>School type mix</CardTitle>
        <Badge soft>Composition</Badge>
      </div>
      {total === 0 ? (
        <p className="text-sm text-claude-text-muted">
          No school-type data yet.
        </p>
      ) : (
        <>
          <div className="flex h-3 rounded-full overflow-hidden bg-claude-bg-subtle">
            {data.map((d, i) => {
              const pct = (d.count / total) * 100;
              return (
                <motion.div
                  key={d.label}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.8, delay: i * 0.1, ease: [0.2, 0.7, 0.2, 1] }}
                  style={{ backgroundColor: COLORS[i % COLORS.length] }}
                />
              );
            })}
          </div>
          <ul className="mt-6 space-y-3">
            {data.map((d, i) => {
              const pct = Math.round((100 * d.count) / total);
              return (
                <motion.li
                  key={d.label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.3 + i * 0.05 }}
                  className="flex items-center justify-between"
                >
                  <span className="flex items-center gap-2 text-sm text-claude-text">
                    <span
                      className="h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: COLORS[i % COLORS.length] }}
                    />
                    {d.label}
                  </span>
                  <span className="text-sm text-claude-text-muted tabular-nums">
                    {d.count.toLocaleString('en-US')}
                    <span className="ml-1 text-claude-text-subtle text-xs">
                      · {pct}%
                    </span>
                  </span>
                </motion.li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------- states

function StatesPanel({
  data,
}: {
  data: PulsePayload['by_state'];
}) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>Where they&apos;re writing from</CardTitle>
        <Badge soft>
          <MapPin className="h-3 w-3 mr-1 inline" />
          {data.length}
        </Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">No location data yet.</p>
      ) : (
        <ul className="space-y-3">
          {data.map((s, i) => {
            const pct = (s.count / max) * 100;
            return (
              <li
                key={s.state}
                className="grid grid-cols-[36px_1fr_40px] items-center gap-3"
              >
                <span className="text-xs text-claude-text-subtle tabular-nums">
                  {s.state}
                </span>
                <div className="relative h-2 rounded-full bg-claude-bg-subtle overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{
                      duration: 0.6,
                      delay: i * 0.04,
                      ease: [0.2, 0.7, 0.2, 1],
                    }}
                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-amber-400 to-amber-500"
                  />
                </div>
                <span className="text-xs text-claude-text font-medium tabular-nums text-right">
                  {s.count}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// --------------------------------------------------------------- top funders

function TopFunders({
  data,
}: {
  data: PulsePayload['top_funders'];
}) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>Funders being targeted</CardTitle>
        <Badge soft>From drafted applications</Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">
          No drafts yet — funders will appear once applications are generated.
        </p>
      ) : (
        <ul className="space-y-4">
          {data.map((f, i) => {
            const pct = (f.count / max) * 100;
            return (
              <li
                key={f.name}
                className="grid grid-cols-[1fr_64px] items-center gap-3"
              >
                <div>
                  <p className="text-sm text-claude-text font-medium leading-snug">
                    {f.name}
                  </p>
                  <div className="mt-1.5 relative h-2 rounded-full bg-claude-bg-subtle overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{
                        duration: 0.7,
                        delay: i * 0.05,
                        ease: [0.2, 0.7, 0.2, 1],
                      }}
                      className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-400 to-violet-600"
                    />
                  </div>
                </div>
                <span className="text-sm text-claude-text font-medium tabular-nums text-right">
                  {f.count} draft{f.count === 1 ? '' : 's'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- top schools

function TopSchools({
  data,
}: {
  data: PulsePayload['top_schools'];
}) {
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>Most active schools</CardTitle>
        <Badge soft>
          <Sparkles className="h-3 w-3 mr-1 inline" />
          Top 8
        </Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">No schools yet.</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {data.map((s, i) => (
            <motion.li
              key={s.name}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.04 }}
              className="flex items-center gap-3 p-3 rounded-xl border border-claude-border bg-white/60"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-claude-text font-medium truncate">
                  {s.name}
                </p>
                <p className="text-[11px] text-claude-text-subtle">
                  {s.state ?? '—'} · {s.count} run{s.count === 1 ? '' : 's'}
                </p>
              </div>
            </motion.li>
          ))}
        </ul>
      )}
    </>
  );
}

// ----------------------------------------------------------------- recent

function RecentFeed({
  data,
}: {
  data: PulsePayload['recent_activity'];
}) {
  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <CardTitle>Live feed</CardTitle>
        <Badge tone="primary" soft dot>
          <Activity className="h-3 w-3 mr-1 inline" />
          {data.length}
        </Badge>
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-claude-text-muted">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-claude-border max-h-[480px] overflow-y-auto pr-1">
          {data.map((e, i) => {
            const isGen = e.event_type === 'generation';
            return (
              <motion.li
                key={`${e.ts}-${i}`}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: i * 0.03 }}
                className="py-3 flex items-start gap-3"
              >
                <span
                  className={cn(
                    'mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full shrink-0',
                    isGen
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-claude-primary/10 text-claude-primary',
                  )}
                >
                  {isGen ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Compass className="h-3.5 w-3.5" />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-claude-text leading-snug">
                    {isGen ? (
                      <>
                        <span className="font-medium">Application drafted</span>
                        {e.selected_grant_title ? (
                          <>
                            {' '}
                            for{' '}
                            <span className="text-claude-primary font-medium">
                              {e.selected_grant_title}
                            </span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="font-medium">Discovery</span> in{' '}
                        <span className="font-medium">{e.sector}</span>
                      </>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-claude-text-subtle truncate">
                    {e.school_name ?? 'Anonymous school'}
                    {e.state ? ` · ${e.state}` : ''} · {formatRelative(e.ts)}
                  </p>
                </div>
              </motion.li>
            );
          })}
        </ul>
      )}
    </>
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
      <Card className="h-52 animate-pulse" />
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 h-72 animate-pulse" />
        <Card className="lg:col-span-2 h-72 animate-pulse" />
      </div>
      <Card className="h-64 animate-pulse" />
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
          The Pulse service did not respond.
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

function EmptyView({ asOf }: { asOf: string }) {
  return (
    <motion.div
      key="empty"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
      className="space-y-6"
    >
      <Card className="relative overflow-hidden p-10 sm:p-14 text-center">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-gradient-to-br from-amber-400/30 via-claude-primary/20 to-transparent blur-3xl" />
        <div className="absolute -bottom-24 -left-24 w-72 h-72 rounded-full bg-gradient-to-tr from-emerald-400/20 via-claude-primary/15 to-transparent blur-3xl" />
        <div className="relative">
          <Badge tone="primary" soft dot>
            Awaiting first real heartbeat
          </Badge>
          <h3 className="mt-5 font-serif text-3xl sm:text-4xl text-claude-text tracking-tight">
            The Pulse begins with one signal.
          </h3>
          <p className="mt-4 max-w-xl mx-auto text-[15px] leading-relaxed text-claude-text-muted">
            No mock data here. Every number on this page is captured live
            the moment a grant coordinator runs Discovery or drafts an
            application in the Writer. Open the Writer, run one search,
            and this page will populate in real time.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3 text-xs text-claude-text-subtle">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Listening on /v2/workflow/discover and /v2/workflow/generate</span>
          </div>
          <p className="mt-8 text-[11px] text-claude-text-subtle">
            Snapshot taken {new Date(asOf).toLocaleString('en-US')}.
          </p>
        </div>
      </Card>
    </motion.div>
  );
}

/** Existe histórico, só não neste recorte. Não é a mesma coisa que estar vazio. */
function QuietWindowView({
  since,
  onShowEverything,
}: {
  since: string;
  onShowEverything: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
    >
      <Card className="p-10 sm:p-14 text-center">
        <Badge soft>Quiet period</Badge>
        <h3 className="mt-5 font-serif text-2xl sm:text-3xl text-claude-text tracking-tight">
          No activity in this window.
        </h3>
        <p className="mt-3 max-w-lg mx-auto text-[15px] leading-relaxed text-claude-text-muted">
          The portal has been recording since{' '}
          {formatShortDate(since)}, so there is history to look at — just
          not in the period you picked.
        </p>
        <button
          onClick={onShowEverything}
          className={cn(
            'mt-6 inline-flex items-center gap-2 rounded-full',
            'border border-claude-border bg-white/70 px-4 py-2 text-sm',
            'text-claude-text-muted hover:bg-white hover:text-claude-text transition',
          )}
        >
          <TrendingUp className="h-3.5 w-3.5" />
          Show all time
        </button>
      </Card>
    </motion.div>
  );
}

/** O Pulse depende de armazenamento. Sem ele, dizemos isso — e o que fazer. */
function UnconfiguredView({ asOf }: { asOf: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
    >
      <Card className="p-10 sm:p-14 text-center">
        <Badge soft>Not recording</Badge>
        <h3 className="mt-5 font-serif text-2xl sm:text-3xl text-claude-text tracking-tight">
          Pulse has nowhere to write.
        </h3>
        <p className="mt-3 max-w-xl mx-auto text-[15px] leading-relaxed text-claude-text-muted">
          Usage is stored in an append-only event log on Azure Blob Storage.
          Set <code className="font-mono text-[13px]">PULSE_STORAGE_ACCOUNT_URL</code>{' '}
          on the backend and grant its identity the{' '}
          <span className="whitespace-nowrap">Storage Blob Data Contributor</span>{' '}
          role. Until then nothing is recorded — and nothing is invented to
          fill the gap.
        </p>
        <p className="mt-8 text-[11px] text-claude-text-subtle">
          Checked {new Date(asOf).toLocaleString('en-US')}.
        </p>
      </Card>
    </motion.div>
  );
}

// ----------------------------------------------------------------- formatting

/** Um balde mensal rotulado "Sep 5" mentiria sobre o que a barra agrega. */
function formatBucketDate(iso: string | undefined, bucket: string): string {
  if (!iso) return '';
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    if (bucket === 'month') {
      return d.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
    const label = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return bucket === 'week' ? `Week of ${label}` : label;
  } catch {
    return iso;
  }
}

function formatBigUsd(n: number): string {
  if (!n) return '$0';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString('en-US')}`;
}

/** O log e particionado por dia UTC, entao as datas dele se leem em UTC.
 *
 * Sem isso, "2026-05-22" (um dia inteiro, nao um instante) vira meia-noite UTC
 * e o fuso do navegador empurra o rotulo para 21 de maio -- o painel passava a
 * afirmar que o historico comecou um dia antes do que comecou. */
function formatShortDate(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
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

// Suppress unused-import lint for TrendingUp (kept available for future stats).
void TrendingUp;
