'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, MapPin, Users, CheckCircle2, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Field } from './Field';
import { Card } from './Card';
import { cn } from './cn';
import type { SchoolData } from '@/components/v2/school';

export interface SchoolPickerProps {
  selected: SchoolData | null;
  onSelect: (s: SchoolData | null) => void;
}

interface ApiResult {
  schools: SchoolData[];
  totalMatches: number;
  hint?: string;
  source?: string;
}

/**
 * v2 school picker — same NCES-backed search as v1, redesigned shell.
 * Hits the existing /api/schools/search endpoint (untouched) so the
 * data path is proven.
 */
export function SchoolPicker({ selected, onSelect }: SchoolPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SchoolData[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      setHint(null);
      return;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/schools/search?q=${encodeURIComponent(query.trim())}&limit=8`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const data: ApiResult = await res.json();
        setResults(data.schools ?? []);
        setHint(data.hint ?? null);
        setOpen(true);
      } catch {
        setResults([]);
        setHint('Search unavailable. Try again.');
        setOpen(true);
      } finally {
        setSearching(false);
      }
    }, 220);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Close on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (selected) {
    return (
      <Card className="relative">
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => {
            onSelect(null);
            setQuery('');
          }}
          className="absolute top-4 right-4 h-7 w-7 grid place-items-center rounded-full text-claude-text-subtle hover:text-claude-text hover:bg-claude-accent-muted transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-c-md bg-claude-primary-soft text-claude-primary grid place-items-center shrink-0">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-claude-text-subtle uppercase tracking-wide mb-1">
              Selected school
            </p>
            <h3 className="font-serif text-h3 text-claude-text truncate">
              {selected.name}
            </h3>
            <p className="text-sm text-claude-text-muted mt-1 flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" /> {selected.city}, {selected.state}
              </span>
              {selected.students > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />{' '}
                  {selected.students.toLocaleString()} students
                </span>
              )}
              {selected.grades && (
                <span className="text-claude-text-subtle">{selected.grades}</span>
              )}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div ref={wrapperRef} className="relative">
      <Field
        label="School"
        placeholder="Search U.S. public schools by name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        leadingIcon={<Search className="h-4 w-4" />}
        trailingSlot={
          searching ? (
            <span className="h-3.5 w-3.5 rounded-full border-2 border-claude-text-subtle border-t-transparent animate-spin" />
          ) : null
        }
      />

      <AnimatePresence>
        {open && (results.length > 0 || hint) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: [0.2, 0.7, 0.2, 1] }}
            className="absolute left-0 right-0 top-full mt-2 z-30"
          >
            <Card density="compact" className="overflow-hidden p-0">
              <ul role="listbox" className="max-h-[360px] overflow-y-auto c-scroll">
                {results.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(s);
                        setOpen(false);
                        setQuery('');
                      }}
                      className={cn(
                        'w-full text-left px-4 py-3 flex items-start gap-3',
                        'hover:bg-claude-accent-muted/60 transition-colors',
                        'border-b border-claude-border last:border-b-0',
                      )}
                    >
                      <div className="h-9 w-9 grid place-items-center rounded-c-sm bg-claude-surface-muted text-claude-text-muted shrink-0">
                        <MapPin className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-claude-text truncate">
                          {s.name}
                        </p>
                        <p className="text-xs text-claude-text-muted truncate">
                          {s.city}, {s.state}
                          {s.students > 0
                            ? ` · ${s.students.toLocaleString()} students`
                            : ''}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
                {hint && results.length === 0 && (
                  <li className="px-4 py-6 text-center text-sm text-claude-text-muted">
                    {hint}
                  </li>
                )}
              </ul>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
