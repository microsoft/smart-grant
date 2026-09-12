'use client';

import { Beaker, Briefcase, BookOpen, HeartPulse, Music, Shield, Languages, GraduationCap, Sparkles } from 'lucide-react';
import { Card } from './Card';
import { Badge } from './Badge';
import { cn } from './cn';
import type { ReactNode } from 'react';

export interface GrantOption {
  key: string;
  name: string;
  amount: string;
  deadline: string;
  /** Family for color/icon grouping. */
  family: 'stem' | 'cte' | 'special-ed' | 'literacy' | 'health' | 'arts' | 'safety' | 'ell' | 'other';
}

/**
 * Curated subset of the v1 GRANT_TYPES list, chosen for visual variety in
 * the picker. The full list is still served by the backend — this is just
 * the on-screen quick-select. A "More…" item could open a sheet later.
 */
export const GRANTS: ReadonlyArray<GrantOption> = [
  { key: 'stem', name: 'NSF STEM Innovation', amount: '$150,000', deadline: '45 days', family: 'stem' },
  { key: 'computer-science', name: 'Computer Science for All', amount: '$180,000', deadline: '50 days', family: 'stem' },
  { key: 'cte', name: 'Perkins V Career & Tech', amount: '$125,000', deadline: '30 days', family: 'cte' },
  { key: 'special-ed', name: 'IDEA Part B Special Ed', amount: '$200,000', deadline: '60 days', family: 'special-ed' },
  { key: 'literacy', name: 'Comprehensive Literacy', amount: '$300,000', deadline: '90 days', family: 'literacy' },
  { key: 'mental-health', name: 'School Mental Health', amount: '$140,000', deadline: '55 days', family: 'health' },
  { key: 'arts', name: 'Arts Education Enhancement', amount: '$90,000', deadline: '48 days', family: 'arts' },
  { key: 'school-safety', name: 'School Safety & Security', amount: '$130,000', deadline: '52 days', family: 'safety' },
  { key: 'ell', name: 'English Language Acquisition', amount: '$135,000', deadline: '58 days', family: 'ell' },
  { key: 'title-i', name: 'Title I School Improvement', amount: '$220,000', deadline: '70 days', family: 'literacy' },
  { key: 'maker-space', name: 'STEM Maker Space', amount: '$200,000', deadline: '55 days', family: 'stem' },
  { key: 'other', name: 'Custom Grant', amount: 'Variable', deadline: '45 days', family: 'other' },
];

const FAMILY_ICON: Record<GrantOption['family'], ReactNode> = {
  stem: <Beaker className="h-4 w-4" />,
  cte: <Briefcase className="h-4 w-4" />,
  'special-ed': <GraduationCap className="h-4 w-4" />,
  literacy: <BookOpen className="h-4 w-4" />,
  health: <HeartPulse className="h-4 w-4" />,
  arts: <Music className="h-4 w-4" />,
  safety: <Shield className="h-4 w-4" />,
  ell: <Languages className="h-4 w-4" />,
  other: <Sparkles className="h-4 w-4" />,
};

export function GrantPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-claude-text-muted mb-3 tracking-wide uppercase">
        Grant type
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {GRANTS.map((g) => {
          const active = value === g.key;
          return (
            <button
              key={g.key}
              type="button"
              onClick={() => onChange(g.key)}
              aria-pressed={active}
              className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-claude-bg rounded-c-xl"
            >
              <Card
                interactive
                density="compact"
                className={cn(
                  'h-full',
                  active &&
                    'border-claude-primary ring-2 ring-claude-primary/25 shadow-c-2',
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'h-9 w-9 grid place-items-center rounded-c-sm shrink-0',
                      active
                        ? 'bg-claude-primary text-white'
                        : 'bg-claude-surface-muted text-claude-text-muted',
                    )}
                  >
                    {FAMILY_ICON[g.family]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-claude-text leading-snug">
                      {g.name}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <Badge tone={active ? 'primary' : 'neutral'} soft>
                        {g.amount}
                      </Badge>
                      <span className="text-xs text-claude-text-subtle tabular-nums">
                        {g.deadline}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            </button>
          );
        })}
      </div>
    </div>
  );
}
