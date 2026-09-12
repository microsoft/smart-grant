'use client';

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingSlot?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { className, label, helper, error, leadingIcon, trailingSlot, id, ...props },
  ref,
) {
  const inputId = id || props.name;
  const describedBy = error ? `${inputId}-err` : helper ? `${inputId}-help` : undefined;

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-xs font-medium text-claude-text-muted mb-2 tracking-wide uppercase"
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          'group flex items-center gap-2 h-11 px-3.5',
          'bg-claude-surface border rounded-c-md transition-all duration-c-base ease-c-out',
          error
            ? 'border-claude-danger/60 focus-within:ring-2 focus-within:ring-claude-danger/30'
            : 'border-claude-border focus-within:border-claude-primary focus-within:ring-2 focus-within:ring-claude-primary/25',
        )}
      >
        {leadingIcon && (
          <span className="text-claude-text-subtle group-focus-within:text-claude-primary transition-colors">
            {leadingIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-describedby={describedBy}
          aria-invalid={!!error || undefined}
          className={cn(
            'flex-1 bg-transparent outline-none placeholder:text-claude-text-subtle',
            'text-claude-text text-sm',
          )}
          {...props}
        />
        {trailingSlot}
      </div>
      {error ? (
        <p id={`${inputId}-err`} className="mt-1.5 text-xs text-claude-danger">
          {error}
        </p>
      ) : helper ? (
        <p id={`${inputId}-help`} className="mt-1.5 text-xs text-claude-text-subtle">
          {helper}
        </p>
      ) : null}
    </div>
  );
});
