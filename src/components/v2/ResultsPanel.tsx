'use client';

/**
 * Final results panel shown when the workflow completes.
 *
 * Hero section: success ring (left) · metadata (center) · download CTA
 * (right). Below: the writer agent's full markdown rendered with
 * Markdown component. Right rail (collapsible on mobile): expandable
 * cards for the supporting agents (Discovery → Intelligence) so users
 * can inspect each step of the pipeline.
 */

import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Download } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import { Badge } from './Badge';
import { Markdown } from './Markdown';
import { SuccessRing } from './SuccessRing';
import { AGENTS } from './AgentStream';
import { buildGrantPdf, type SchoolProfileData } from './pdf';
import { cn } from './cn';

interface ResultsPanelProps {
  schoolName: string;
  schoolLocation: string;
  schoolProfile?: SchoolProfileData;
  grantName: string;
  grantKey: string;
  outputs: Record<number, string>;
}

const WRITER_INDEX = 5;

export function ResultsPanel({
  schoolName,
  schoolLocation,
  schoolProfile,
  grantName,
  grantKey,
  outputs,
}: ResultsPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const writerOutput = outputs[WRITER_INDEX] ?? '';
  const generatedAt = useMemo(() => new Date(), []);
  const successScore = useMemo(
    () => deriveSuccessScore(outputs[4] ?? ''),
    [outputs],
  );

  const onDownload = useCallback(() => {
    if (!writerOutput.trim()) return;
    const doc = buildGrantPdf({
      schoolName,
      schoolLocation,
      schoolProfile,
      grantName,
      generatedAt,
      writerMarkdown: writerOutput,
    });
    const safeSchool = schoolName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    doc.save(`${safeSchool}-${grantKey}-application.pdf`);
  }, [
    writerOutput,
    schoolName,
    schoolLocation,
    schoolProfile,
    grantName,
    grantKey,
    generatedAt,
  ]);

  return (
    <div className="space-y-8">
      {/* Hero */}
      <Card className="relative overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-8 items-center">
          <SuccessRing score={successScore} />

          <div className="min-w-0 space-y-1">
            <Badge tone="primary" soft>
              Application complete
            </Badge>
            <h2 className="font-serif text-3xl tracking-tight text-claude-text mt-2">
              {grantName}
            </h2>
            <p className="text-claude-text-muted">
              For{' '}
              <span className="text-claude-text font-medium">{schoolName}</span>
              {schoolLocation && <> · {schoolLocation}</>}
            </p>
            <p className="text-xs text-claude-text-subtle mt-1">
              Generated{' '}
              {generatedAt.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              leadingIcon={<Download className="h-4 w-4" />}
              onClick={onDownload}
              disabled={!writerOutput.trim()}
            >
              Download PDF
            </Button>
            <p className="text-[11px] text-claude-text-subtle text-center">
              Cover · TOC · Applicant profile · 10 sections · Charts · Signatures
            </p>
          </div>
        </div>
      </Card>

      {/* Supporting agents */}
      <div>
        <p className="text-[11px] uppercase tracking-wide text-claude-text-subtle px-1 mb-3">
          Pipeline outputs
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {AGENTS.filter((a) => a.index < WRITER_INDEX).map((a) => {
            const body = outputs[a.index] ?? '';
            const isOpen = expanded === a.index;
            const hasContent = body.trim().length > 0;
            return (
              <Card key={a.index} density="compact" className="p-0 overflow-hidden">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => (prev === a.index ? null : a.index))
                  }
                  className={cn(
                    'w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors',
                    'hover:bg-claude-surface-muted/40',
                    !hasContent && 'opacity-60 cursor-not-allowed',
                  )}
                  disabled={!hasContent}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-claude-text truncate">
                      {a.name}
                    </p>
                    <p className="text-xs text-claude-text-subtle truncate">
                      {a.role}
                    </p>
                  </div>
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-claude-text-subtle transition-transform shrink-0',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && hasContent && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.2, 0.7, 0.2, 1] }}
                      className="overflow-hidden border-t border-claude-border"
                    >
                      <div className="px-4 py-3 text-sm">
                        <Markdown>{body}</Markdown>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Extract the 0–100 success probability from the intelligence agent's
 * output. Returns null when the agent did not report one — the ring then
 * shows no number, because an invented probability of winning funding is
 * worse than an absent one.
 */
function deriveSuccessScore(intelligence: string): number | null {
  if (!intelligence) return null;
  const candidates = [
    /success[^\n]{0,40}probability[^\d]{0,12}(\d{1,3})/i,
    /probability[^\n]{0,12}of\s+success[^\d]{0,12}(\d{1,3})/i,
    /score[^\d]{0,12}(\d{1,3})/i,
    /(\d{1,3})\s*%[^\n]{0,40}(?:success|win|likelihood)/i,
  ];
  for (const re of candidates) {
    const m = re.exec(intelligence);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 0 && v <= 100) return v;
    }
  }
  return null;
}
