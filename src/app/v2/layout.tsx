import type { Metadata } from 'next';
import { Inter, Source_Serif_4, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { SchoolIndexProvider } from '@/components/v2/SchoolIndexContext';
import { schoolIndexCount } from '@/services/school-index';

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const serif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-serif',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Smart Grant Request · v2',
  description:
    'Specialist AI agents find open federal grants for U.S. schools and draft submission-ready applications — powered by GPT-5.4 on Azure AI Foundry and the Microsoft Agent Framework.',
};

/**
 * Server component, which is what lets it read the school index off disk
 * and hand the count to the client tree below.
 */
export default function V2Layout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`v2-root ${sans.variable} ${serif.variable} ${mono.variable} bg-claude-bg text-claude-text min-h-screen`}
    >
      <SchoolIndexProvider count={schoolIndexCount()}>
        {children}
      </SchoolIndexProvider>
    </div>
  );
}
