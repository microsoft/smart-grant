'use client';

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** When true, hover gets a subtle elevation lift. */
  interactive?: boolean;
  /** Tighten padding for dense lists. */
  density?: 'comfortable' | 'compact';
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, interactive, density = 'comfortable', children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'bg-claude-surface border border-claude-border rounded-c-xl shadow-c-1',
        'transition-all duration-c-base ease-c-out',
        density === 'comfortable' ? 'p-6' : 'p-4',
        interactive && 'hover:shadow-c-2 hover:border-claude-border-strong cursor-pointer',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4', className)} {...props} />;
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Small uppercase kicker rendered above the title. */
  eyebrow?: string;
  /** Title text. Provide this or `children`, not both. */
  title?: string;
  /** Supporting line rendered below the title. */
  description?: string;
}

export function CardTitle({
  className,
  eyebrow,
  title,
  description,
  children,
  ...props
}: CardTitleProps) {
  const heading = (
    <h3
      className={cn(
        'font-serif text-h3 text-claude-text tracking-tight',
        className,
      )}
      {...props}
    >
      {title ?? children}
    </h3>
  );

  // Plain usage stays exactly as before — no wrapper, no layout shift.
  if (!eyebrow && !description) return heading;

  return (
    <div>
      {eyebrow && (
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-claude-text-subtle">
          {eyebrow}
        </div>
      )}
      {heading}
      {description && (
        <p className="mt-1 text-sm text-claude-text-muted">{description}</p>
      )}
    </div>
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-1 text-sm text-claude-text-muted', className)} {...props} />;
}
