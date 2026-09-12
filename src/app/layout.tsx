import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Grant Writing Platform - Agent Framework',
  description: 'Enterprise multi-agent grant writing system powered by Microsoft Agent Framework. Watch 6 AI agents collaborate to create complete grant applications in 3 minutes.',
  keywords: ['grant writing', 'AI', 'education', 'K-12', 'agent framework', 'Claude'],
  authors: [{ name: 'AI Agent Framework Team' }],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#4f46e5" />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
