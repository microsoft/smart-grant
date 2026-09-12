/**
 * /v2/office — the cinematic mirror.
 *
 * Layout is unchanged in spirit: the exact WriterStudio from /v2 on top,
 * a live 3D office below it. The mirror is still strictly one-way — the
 * Studio is the source of truth and does not know or care that anything
 * is watching.
 *
 * What changed is the plumbing between them. This page used to keep an
 * ever-growing array of every MirrorEvent, copy it on each token, and bump
 * React state — re-rendering the page, the Studio, and the whole 3D tree
 * hundreds of times a second. That array is gone. Events now go straight
 * into a `MirrorStore`, which routes structural changes to React and the
 * token firehose to a mutable channel the renderer samples per frame.
 */

'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Header, type V2View } from '@/components/v2/Header';
import { Hero } from '@/components/v2/Hero';
import { WriterStudio } from '@/components/v2/WriterStudio';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MirrorStore } from '@/components/v2/office3d/mirrorStore';

// three.js cannot render on the server — the office is client-only. The
// Studio above stays fully SSR-compatible.
const Office3D = dynamic(
  () => import('@/components/v2/office3d/Office3D').then((m) => m.Office3D),
  {
    ssr: false,
    loading: () => (
      <div className="grid aspect-[4/3] w-full place-items-center rounded-2xl border border-claude-border bg-[#141210] sm:aspect-[16/10] lg:aspect-[2/1]">
        <span className="text-sm text-claude-text-subtle">Lighting the set…</span>
      </div>
    ),
  },
);

export default function OfficePage() {
  const [view, setView] = useState<V2View>('writer');

  // One store for the life of the page. `store.push` has a stable identity,
  // so WriterStudio's `onMirror` prop never changes.
  const store = useMemo(() => new MirrorStore(), []);

  return (
    <>
      <Header view={view} onViewChange={setView} />
      <main className="pb-24">
        <Hero />
        <div className="mx-auto max-w-6xl space-y-10 px-6">
          {/* The SAME Studio as /v2 — full UI, full functionality. */}
          <WriterStudio onMirror={store.push} />

          <section>
            <div className="mb-4 flex items-end justify-between gap-6">
              <div>
                <h2 className="font-serif text-xl text-claude-text">The Grant Office</h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-claude-text-subtle">
                  A live mirror of the work above. The camera follows whoever is
                  writing, and the text on their monitor is the real output —
                  not a simulation.
                </p>
              </div>
              <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-claude-border bg-claude-bg-elevated px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-claude-text-subtle sm:inline-flex">
                Live mirror
              </span>
            </div>

            {/* A WebGL failure must never take down the application above. */}
            <ErrorBoundary
              fallback={
                <div className="grid aspect-[4/3] w-full place-items-center rounded-2xl border border-claude-border bg-claude-bg-elevated px-6 text-center sm:aspect-[16/10] lg:aspect-[2/1]">
                  <p className="text-sm text-claude-text-subtle">
                    The 3D office could not start on this device. Everything
                    above continues to work normally.
                  </p>
                </div>
              }
            >
              <Office3D store={store} />
            </ErrorBoundary>
          </section>
        </div>
      </main>

      <footer className="border-t border-claude-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-xs text-claude-text-subtle">
          <span>
            Smart Grant Request v2 · Office mirror · Microsoft Agent Framework +
            React Three Fiber
          </span>
          <a href="/v2" className="transition-colors hover:text-claude-text">
            Back to main Studio
          </a>
        </div>
      </footer>
    </>
  );
}
