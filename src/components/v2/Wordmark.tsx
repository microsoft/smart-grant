'use client';

import { Sparkles } from 'lucide-react';
import { cn } from './cn';

/**
 * v2 wordmark.
 *
 * The icon is a tiny serif spark — a nod to *writing* (the document) and
 * *intelligence* (the spark) without leaning on a generic logo.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden
        className="grid place-items-center h-8 w-8 rounded-c-sm bg-claude-primary text-white shadow-c-1"
      >
        <Sparkles className="h-4 w-4" strokeWidth={2.25} />
      </span>
      <span className="font-serif text-[17px] tracking-tight text-claude-text">
        Smart Grant Request
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-claude-text-subtle font-medium">
        v2
      </span>
    </div>
  );
}
