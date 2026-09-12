'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, ChevronDown, Loader2, Circle, AlertTriangle } from 'lucide-react';
import { cn } from './cn';

/**
 * Strip pictographic emojis from agent output. Real consulting documents
 * use bold labels and clean typography — no decorative bullets, no
 * substitution glyphs. We strip every pictographic codepoint and let the
 * markdown structure (bold, lists, headings) carry the visual rhythm.
 */
function cleanForDisplay(text: string): string {
  if (!text) return text;
  return text
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2300}-\u{23FF}]/gu, '')
    .replace(/[\u{2500}-\u{25FF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\u00A4|\u00A7|\u00B6/g, '')
    .replace(/\u200D/g, '')
    // Collapse leading whitespace left after stripping a line-leading glyph.
    .replace(/^[ \t]+/gm, '')
    // Collapse double spaces created mid-line.
    .replace(/ {2,}/g, ' ');
}

export type AgentStatus = 'pending' | 'streaming' | 'complete' | 'error';

export interface AgentInfo {
  index: number;
  name: string;
  role: string;
  description: string;
}

export const AGENTS: ReadonlyArray<AgentInfo> = [
  {
    index: 0,
    name: 'Discovery',
    role: 'Grant Matching Specialist',
    description: 'Searches live federal & state portals for the right opportunity.',
  },
  {
    index: 1,
    name: 'Narrative',
    role: 'Compelling Grant Writer',
    description: 'Drafts the needs assessment and theory of change.',
  },
  {
    index: 2,
    name: 'Budget',
    role: 'Financial Planning Specialist',
    description: 'Builds a line-item budget with category-level justifications.',
  },
  {
    index: 3,
    name: 'Compliance',
    role: 'Quality Assurance Specialist',
    description: 'Validates the application against the funder rubric.',
  },
  {
    index: 4,
    name: 'Intelligence',
    role: 'AI Insights Specialist',
    description: 'Scores success probability and recommends revisions.',
  },
  {
    index: 5,
    name: 'Writer',
    role: 'Application Writer',
    description: 'Synthesizes the final 4,000-word submission-ready document.',
  },
];

interface AgentStreamProps {
  agents: ReadonlyArray<AgentInfo>;
  current: number;
  outputs: Record<number, string>;
  statuses: Record<number, AgentStatus>;
  errors: Record<number, string | undefined>;
}

export function AgentStream({
  agents,
  current,
  outputs,
  statuses,
  errors,
}: AgentStreamProps) {
  return (
    <div className="space-y-4">
      {agents.map((a) => {
        const status = statuses[a.index] ?? 'pending';
        const output = outputs[a.index] ?? '';
        const isCurrent = current === a.index && status !== 'complete';
        return (
          <AgentRow
            key={a.index}
            agent={a}
            status={status}
            output={output}
            isCurrent={isCurrent}
            error={errors[a.index]}
          />
        );
      })}
    </div>
  );
}

function AgentRow({
  agent,
  status,
  output,
  isCurrent,
  error,
}: {
  agent: AgentInfo;
  status: AgentStatus;
  output: string;
  isCurrent: boolean;
  error?: string;
}) {
  // Default collapsed — the live stream stays calm; the user can click to
  // peek inside any agent that interests them.
  const [open, setOpen] = useState(false);
  const canExpand = status !== 'pending';

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
      className={cn(
        'rounded-c-xl border bg-claude-surface shadow-c-1 overflow-hidden',
        'transition-all duration-c-base ease-c-out',
        isCurrent
          ? 'border-claude-primary/40 shadow-c-2'
          : 'border-claude-border',
      )}
    >
      {/* header */}
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        className={cn(
          'w-full flex items-center gap-4 px-5 py-4 text-left',
          canExpand ? 'hover:bg-claude-surface-muted/30 cursor-pointer' : 'cursor-default',
        )}
        aria-expanded={open}
      >
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-claude-text-subtle tabular-nums">
              0{agent.index + 1}
            </span>
            <h3 className="font-serif text-h3 text-claude-text leading-none">
              {agent.name}
            </h3>
            <span className="text-xs text-claude-text-muted">{agent.role}</span>
          </div>
          <p className="mt-1.5 text-sm text-claude-text-muted">
            {agent.description}
          </p>
        </div>
        <StatusBadge status={status} />
        {canExpand && (
          <ChevronDown
            className={cn(
              'h-4 w-4 text-claude-text-subtle transition-transform shrink-0',
              open && 'rotate-180',
            )}
          />
        )}
      </button>

      {/* body */}
      <AnimatePresence initial={false}>
        {open && status !== 'pending' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.2, 0.7, 0.2, 1] }}
            className="overflow-hidden border-t border-claude-border bg-claude-surface-muted/40"
          >
            <div className="px-5 py-4">
              {error ? (
                <p className="text-sm text-claude-danger flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  {error}
                </p>
              ) : output ? (
                <StreamProse text={cleanForDisplay(output)} active={isCurrent} />
              ) : (
                <ShimmerLines />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function StatusIcon({ status }: { status: AgentStatus }) {
  const base = 'h-9 w-9 grid place-items-center rounded-c-sm shrink-0 transition-colors duration-c-base';
  if (status === 'complete') {
    return (
      <span className={cn(base, 'bg-claude-success/12 text-claude-success')}>
        <CheckCircle2 className="h-5 w-5" />
      </span>
    );
  }
  if (status === 'streaming') {
    return (
      <span className={cn(base, 'bg-claude-primary/15 text-claude-primary')}>
        <Loader2 className="h-5 w-5 animate-spin" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className={cn(base, 'bg-claude-danger/12 text-claude-danger')}>
        <AlertTriangle className="h-5 w-5" />
      </span>
    );
  }
  return (
    <span className={cn(base, 'bg-claude-surface-muted text-claude-text-subtle')}>
      <Circle className="h-5 w-5" strokeWidth={1.5} />
    </span>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  const map: Record<AgentStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' }> = {
    pending: { label: 'Queued', tone: 'neutral' },
    streaming: { label: 'Streaming', tone: 'primary' },
    complete: { label: 'Complete', tone: 'success' },
    error: { label: 'Error', tone: 'danger' },
  };
  const { label, tone } = map[status];
  return (
    <span
      className={cn(
        'text-xs font-medium tabular-nums px-2.5 py-1 rounded-full',
        tone === 'neutral' && 'bg-claude-accent-muted text-claude-text-subtle',
        tone === 'primary' && 'bg-claude-primary-soft text-claude-primary-hover',
        tone === 'success' && 'bg-claude-success/15 text-claude-success',
        tone === 'danger' && 'bg-claude-danger/15 text-claude-danger',
      )}
    >
      {label}
    </span>
  );
}

function ShimmerLines() {
  return (
    <div className="space-y-2">
      <div className="h-3 rounded-full c-shimmer w-11/12" />
      <div className="h-3 rounded-full c-shimmer w-9/12" />
      <div className="h-3 rounded-full c-shimmer w-10/12" />
    </div>
  );
}

/**
 * Render the agent's incremental text. We use prose-like sizing but keep
 * the surface light: this is a working stream, not a final document.
 */
function StreamProse({ text, active }: { text: string; active: boolean }) {
  // Convert escaped newlines from the SSE adapter back to real ones.
  const normalized = text.replace(/\\n/g, '\n');
  return (
    <div className="relative">
      <div
        className={cn(
          'whitespace-pre-wrap text-[15px] leading-relaxed text-claude-text',
          'font-sans max-h-[320px] overflow-y-auto c-scroll pr-2',
        )}
        aria-live="polite"
      >
        {normalized}
        {active && (
          <span
            aria-hidden
            className="inline-block w-[7px] h-[1em] align-text-bottom translate-y-[2px] bg-claude-primary ml-[1px] animate-pulse-soft"
          />
        )}
      </div>
    </div>
  );
}
