'use client';

import { useRouter } from 'next/navigation';
import { Wordmark } from './Wordmark';
import { Tabs, type TabItem } from './Tabs';
import { Button } from './Button';
import { LogOut } from 'lucide-react';

export type V2View = 'writer' | 'analytics' | 'pulse';

const TABS: ReadonlyArray<TabItem<V2View>> = [
  { id: 'writer', label: 'Writer' },
  { id: 'analytics', label: 'Landscape' },
  { id: 'pulse', label: 'Pulse' },
];

export function Header({
  view,
  onViewChange,
}: {
  view: V2View;
  onViewChange: (v: V2View) => void;
}) {
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 backdrop-blur-xl bg-claude-bg/85 border-b border-claude-border">
      <div className="max-w-6xl mx-auto px-6">
        <div className="h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Wordmark />
            <div className="hidden md:block h-6 w-px bg-claude-border" />
            <Tabs items={TABS} active={view} onChange={onViewChange} className="hidden md:flex" />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-claude-text-subtle">
              <span className="h-1.5 w-1.5 rounded-full bg-claude-success animate-pulse-soft" />
              Live
            </span>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<LogOut className="h-3.5 w-3.5" />}
              onClick={handleLogout}
            >
              Sign out
            </Button>
          </div>
        </div>
        {/* Mobile tabs */}
        <div className="md:hidden pb-2">
          <Tabs items={TABS} active={view} onChange={onViewChange} />
        </div>
      </div>
    </header>
  );
}
