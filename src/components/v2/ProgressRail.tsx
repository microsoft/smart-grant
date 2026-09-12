'use client';

import { motion } from 'framer-motion';
import { cn } from './cn';
import { AGENTS } from './AgentStream';

interface ProgressRailProps {
  current: number;
  completed: number;
  total?: number;
}

/**
 * A thin vertical rail showing position through the six-agent pipeline.
 * Sticky on the left of the studio.
 */
export function ProgressRail({
  current,
  completed,
  total = AGENTS.length,
}: ProgressRailProps) {
  const percent = Math.min(100, Math.round((completed / total) * 100));

  return (
    <aside className="hidden lg:block sticky top-24 self-start">
      <div className="bg-claude-surface border border-claude-border rounded-c-xl p-5 shadow-c-1 w-[220px]">
        <p className="text-xs font-medium text-claude-text-subtle uppercase tracking-wide">
          Progress
        </p>
        <div className="mt-3 flex items-baseline gap-1">
          <span className="font-serif text-3xl text-claude-text tabular-nums">
            {percent}
          </span>
          <span className="text-claude-text-subtle text-sm">%</span>
        </div>
        <div className="mt-2 h-1.5 bg-claude-accent-muted rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-claude-primary"
            initial={false}
            animate={{ width: `${percent}%` }}
            transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
          />
        </div>

        <ol className="mt-5 space-y-2.5">
          {AGENTS.map((a) => {
            const isDone = a.index < completed;
            const isActive = a.index === current && !isDone;
            return (
              <li
                key={a.index}
                className="flex items-center gap-2.5 text-[13px]"
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-1.5 rounded-full shrink-0 transition-colors',
                    isDone && 'bg-claude-success',
                    isActive && 'bg-claude-primary animate-pulse-soft',
                    !isDone && !isActive && 'bg-claude-border-strong',
                  )}
                />
                <span
                  className={cn(
                    'truncate',
                    isDone && 'text-claude-text',
                    isActive && 'text-claude-text font-medium',
                    !isDone && !isActive && 'text-claude-text-subtle',
                  )}
                >
                  {a.name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}
