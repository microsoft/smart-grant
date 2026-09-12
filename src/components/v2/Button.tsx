'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-claude-primary text-white hover:bg-claude-primary-hover ' +
    'shadow-c-1 hover:shadow-c-2 active:translate-y-px',
  secondary:
    'bg-claude-surface text-claude-text border border-claude-border ' +
    'hover:bg-claude-surface-muted hover:border-claude-border-strong shadow-c-1',
  ghost:
    'bg-transparent text-claude-text-muted hover:text-claude-text ' +
    'hover:bg-claude-accent-muted/50',
  danger:
    'bg-claude-danger text-white hover:opacity-90 shadow-c-1',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm rounded-c-sm',
  md: 'h-10 px-4 text-sm rounded-c-md',
  lg: 'h-12 px-6 text-base rounded-c-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'primary',
    size = 'md',
    loading,
    disabled,
    leadingIcon,
    trailingIcon,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium',
        'transition-all duration-c-base ease-c-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-claude-bg',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : (
        leadingIcon
      )}
      {children}
      {!loading && trailingIcon}
    </button>
  );
});
