/**
 * Tiny class-name joiner. Avoids pulling clsx/twMerge into the v2 surface
 * (we already have them as deps, but keeping a local helper means v2 has
 * a single import path and zero indirection in components).
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
