'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * How many schools the picker can actually find.
 *
 * The number lives in `data/schools-index.json`, which only the server can
 * read, but the components that quote it are client components on more
 * than one route. A context set once by the v2 layout keeps the figure
 * tied to the data without threading a prop through every page.
 *
 * `null` means no index is built. Callers should say nothing in that case
 * rather than fall back to a guess.
 */
const SchoolIndexContext = createContext<number | null>(null);

export function SchoolIndexProvider({
  count,
  children,
}: {
  count: number | null;
  children: ReactNode;
}) {
  return (
    <SchoolIndexContext.Provider value={count}>
      {children}
    </SchoolIndexContext.Provider>
  );
}

export function useSchoolCount(): number | null {
  return useContext(SchoolIndexContext);
}
