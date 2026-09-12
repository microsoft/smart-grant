'use client';

/**
 * Markdown renderer styled to match the v2 design language.
 *
 * Built on top of `react-markdown` + `remark-gfm` so the writer agent's
 * output (headings, lists, tables, blockquotes, code) renders with the
 * same Apple-design-studio polish as the rest of the v2 surface.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from './cn';

interface MarkdownProps {
  children: string;
  className?: string;
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="font-serif text-3xl tracking-tight text-claude-text mt-10 mb-4">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-serif text-2xl tracking-tight text-claude-text mt-10 mb-3">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-serif text-xl text-claude-text mt-8 mb-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-base font-semibold text-claude-text mt-6 mb-2 uppercase tracking-wide">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="text-claude-text-muted leading-relaxed my-4">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-4 ml-5 list-disc space-y-1.5 text-claude-text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 ml-5 list-decimal space-y-1.5 text-claude-text-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => (
    <strong className="text-claude-text font-semibold">{children}</strong>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-6 border-l-2 border-claude-primary pl-4 italic text-claude-text-muted">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = (className ?? '').includes('language-');
    if (isBlock) {
      return (
        <pre className="my-4 overflow-x-auto rounded-lg bg-claude-surface-muted p-4 text-sm">
          <code className="font-mono text-claude-text">{children}</code>
        </pre>
      );
    }
    return (
      <code className="rounded bg-claude-surface-muted px-1.5 py-0.5 font-mono text-[0.85em] text-claude-text">
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="my-6 overflow-x-auto rounded-lg border border-claude-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-claude-surface-muted">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-claude-border px-4 py-2.5 text-left font-medium text-claude-text">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-claude-border/60 px-4 py-2.5 text-claude-text-muted">
      {children}
    </td>
  ),
  tr: ({ children }) => <tr className="even:bg-claude-surface-muted/30">{children}</tr>,
  hr: () => <hr className="my-8 border-claude-border" />,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-claude-primary underline-offset-2 hover:underline"
    >
      {children}
    </a>
  ),
};

export function Markdown({ children, className }: MarkdownProps) {
  // Strip pictographic emojis. Consulting-grade typography: bold labels
  // and lists carry the structure, not decorative glyphs.
  const cleaned = (children ?? '')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{2300}-\u{23FF}]/gu, '')
    .replace(/[\u{2500}-\u{25FF}]/gu, '')
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\u00A4|\u00A7|\u00B6/g, '')
    .replace(/\u200D/g, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/ {2,}/g, ' ');
  return (
    <div className={cn('max-w-none', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}
