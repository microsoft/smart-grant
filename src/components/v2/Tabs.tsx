'use client';

import { motion } from 'framer-motion';
import { cn } from './cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export interface TabsProps<T extends string> {
  items: ReadonlyArray<TabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}

/**
 * Underline tabs with an animated indicator (Framer Motion `layoutId`).
 * The indicator slides between tabs on change — purposeful, not bouncy.
 */
export function Tabs<T extends string>({
  items,
  active,
  onChange,
  className,
}: TabsProps<T>) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1', className)}>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative px-3 h-10 inline-flex items-center gap-2 text-sm font-medium',
              'transition-colors duration-c-base ease-c-out',
              isActive
                ? 'text-claude-text'
                : 'text-claude-text-muted hover:text-claude-text',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-primary/40 rounded-c-sm',
            )}
          >
            <span>{item.label}</span>
            {typeof item.count === 'number' && (
              <span className="text-xs text-claude-text-subtle tabular-nums">
                {item.count}
              </span>
            )}
            {isActive && (
              <motion.span
                layoutId="v2-tabs-indicator"
                className="absolute inset-x-2 -bottom-px h-[2px] bg-claude-primary rounded-full"
                transition={{
                  type: 'spring',
                  stiffness: 380,
                  damping: 32,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
