'use client';

import { useState } from 'react';
import { Header, type V2View } from '@/components/v2/Header';
import { Hero } from '@/components/v2/Hero';
import { WriterStudio } from '@/components/v2/WriterStudio';
import { AnalyticsCanvas } from '@/components/v2/AnalyticsCanvas';
import { PulseCanvas } from '@/components/v2/PulseCanvas';

export default function V2Page() {
  const [view, setView] = useState<V2View>('writer');

  return (
    <>
      <Header view={view} onViewChange={setView} />
      <main className="pb-24">
        {view === 'writer' ? (
          <>
            <Hero />
            <div className="max-w-6xl mx-auto px-6">
              <WriterStudio />
            </div>
          </>
        ) : view === 'analytics' ? (
          <div className="max-w-6xl mx-auto px-6 pt-12">
            <AnalyticsCanvas />
          </div>
        ) : (
          <div className="max-w-6xl mx-auto px-6 pt-12">
            <PulseCanvas />
          </div>
        )}
      </main>
      <footer className="border-t border-claude-border">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-xs text-claude-text-subtle">
          <span>
            Smart Grant Request v2 · MIT licensed · Built with Microsoft Agent Framework
          </span>
          <span>
            <a
              href="https://github.com/microsoft/smart-grant"
              target="_blank"
              rel="noreferrer noopener"
              className="hover:text-claude-text transition-colors"
            >
              GitHub
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
