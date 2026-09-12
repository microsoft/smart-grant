'use client';

/**
 * Animated SVG ring displaying a success-probability score (0–100).
 *
 * The ring fills smoothly via Framer Motion's `animate` prop on
 * `strokeDashoffset`, with a tabular-nums numeral centred inside.
 */

import { motion } from 'framer-motion';

interface SuccessRingProps {
  score: number | null;
  label?: string;
  size?: number;
  stroke?: number;
}

export function SuccessRing({
  score,
  label = 'Success Probability',
  size = 168,
  stroke = 12,
}: SuccessRingProps) {
  const clamped = score === null ? null : Math.min(100, Math.max(0, Math.round(score)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - (clamped ?? 0) / 100);

  return (
    <div
      className="relative inline-flex flex-col items-center justify-center"
      style={{ width: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
          fill="none"
          className="text-claude-border"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          className="text-claude-primary"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-4xl tabular-nums text-claude-text">
          {clamped === null ? (
            <span className="text-2xl text-claude-text-muted">Not reported</span>
          ) : (
            <>
              {clamped}
              <span className="text-2xl text-claude-text-muted">%</span>
            </>
          )}
        </span>
        <span className="mt-1 text-[11px] uppercase tracking-wide text-claude-text-subtle">
          {label}
        </span>
      </div>
    </div>
  );
}
