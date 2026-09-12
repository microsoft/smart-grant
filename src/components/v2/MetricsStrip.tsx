'use client';

/**
 * Live metrics strip shown while the workflow is running.
 *
 * Four compact stat tiles laid out horizontally:
 *   - Elapsed time (mm:ss)
 *   - Active agent (N of total)
 *   - Tokens streamed
 *   - Agents complete (N / total)
 */

import { Activity, Clock, Hash, Users } from 'lucide-react';
import { Card } from './Card';

interface MetricsStripProps {
  elapsedMs: number;
  current: number;
  completed: number;
  totalAgents: number;
  tokens: number;
  currentName: string;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface TileProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}

function Tile({ icon, label, value, hint }: TileProps) {
  return (
    <Card density="compact" className="min-w-0">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-claude-surface-muted p-2 text-claude-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-claude-text-subtle">
            {label}
          </p>
          <p className="font-serif text-2xl tabular-nums text-claude-text mt-0.5 truncate">
            {value}
          </p>
          {hint && (
            <p className="text-xs text-claude-text-muted mt-0.5 truncate">{hint}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

export function MetricsStrip({
  elapsedMs,
  current,
  completed,
  totalAgents,
  tokens,
  currentName,
}: MetricsStripProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Tile
        icon={<Clock className="h-4 w-4" />}
        label="Elapsed"
        value={formatElapsed(elapsedMs)}
      />
      <Tile
        icon={<Activity className="h-4 w-4" />}
        label="Active agent"
        value={current >= 0 ? `${current + 1} / ${totalAgents}` : '—'}
        hint={currentName || 'waiting'}
      />
      <Tile
        icon={<Hash className="h-4 w-4" />}
        label="Tokens streamed"
        value={formatNumber(tokens)}
      />
      <Tile
        icon={<Users className="h-4 w-4" />}
        label="Completed"
        value={`${completed} / ${totalAgents}`}
      />
    </div>
  );
}
