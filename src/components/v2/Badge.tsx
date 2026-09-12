'use client';

import { type HTMLAttributes } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** When true, uses a soft tinted background instead of border. */
  soft?: boolean;
  dot?: boolean;
}

const TONES_OUTLINE: Record<Tone, string> = {
  neutral: 'border-claude-border text-claude-text-muted bg-claude-surface',
  primary: 'border-claude-primary/40 text-claude-primary bg-claude-primary-soft/40',
  success: 'border-claude-success/40 text-claude-success bg-claude-success/10',
  warning: 'border-claude-warning/40 text-claude-warning bg-claude-warning/10',
  danger: 'border-claude-danger/40 text-claude-danger bg-claude-danger/10',
};

const TONES_SOFT: Record<Tone, string> = {
  neutral: 'bg-claude-accent-muted text-claude-text',
  primary: 'bg-claude-primary-soft text-claude-primary-hover',
  success: 'bg-claude-success/15 text-claude-success',
  warning: 'bg-claude-warning/15 text-claude-warning',
  danger: 'bg-claude-danger/15 text-claude-danger',
};

const DOT_COLORS: Record<Tone, string> = {
  neutral: 'bg-claude-text-subtle',
  primary: 'bg-claude-primary',
  success: 'bg-claude-success',
  warning: 'bg-claude-warning',
  danger: 'bg-claude-danger',
};

export function Badge({
  className,
  tone = 'neutral',
  soft,
  dot,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium tabular-nums',
        soft ? TONES_SOFT[tone] : `border ${TONES_OUTLINE[tone]}`,
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', DOT_COLORS[tone])}
        />
      )}
      {children}
    </span>
  );
}
