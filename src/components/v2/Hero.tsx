'use client';

import { motion } from 'framer-motion';
import { Badge } from './Badge';
import { useSchoolCount } from './SchoolIndexContext';

/**
 * The hero sets the tone: serif headline, a one-line promise, and a calm
 * meta strip. No CTAs, no gradients — the work is downstream, not here.
 *
 * The copy describes the pipeline that actually runs. It used to say six
 * agents "collaborate live", which read as one continuous chain; the real
 * flow stops after discovery and waits for a person to choose the grant.
 * It also promised five minutes, which nothing in the system measures,
 * and quoted 130,000 schools, which is the size of the federal database
 * rather than the index this app searches.
 */
export function Hero() {
  const schoolCount = useSchoolCount();

  return (
    <section className="relative overflow-hidden">
      <div className="max-w-4xl mx-auto px-6 pt-16 pb-12">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
          className="space-y-6"
        >
          <div className="flex items-center gap-2">
            <Badge tone="primary" soft dot>
              GPT-5.4 · Azure AI Foundry
            </Badge>
            <Badge soft>Microsoft Agent Framework</Badge>
          </div>
          <h1 className="font-serif text-display-sm md:text-display text-claude-text tracking-tight text-balance">
            Submission-ready grant applications,{' '}
            <span className="text-claude-primary">grounded in federal data.</span>
          </h1>
          <p className="text-lg text-claude-text-muted max-w-2xl leading-relaxed">
            A discovery agent ranks open Grants.gov opportunities against your
            school
            {schoolCount !== null && (
              <> — one of {schoolCount.toLocaleString('en-US')} real NCES records</>
            )}
            . You choose which to pursue; narrative, budget, compliance,
            intelligence, and writing agents draft the application, live.
          </p>
        </motion.div>
      </div>

      {/* warm, almost-imperceptible top glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[720px] h-[320px]"
        style={{
          background:
            'radial-gradient(closest-side, rgb(217 119 87 / 0.10), transparent 80%)',
        }}
      />
    </section>
  );
}
