// An email's pasted HTML: what is taken out of it (scripts, frames, forms),
// what is added to it (the hidden preview line, the footer, a test strip),
// its links rewritten, and its words for the plain-text part. Plain string
// work, no parser, so it runs the same in the browser and on the server.
// Imports nothing.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** The few entities a title or a line of text carries. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10) || 32);
    return ENTITIES[lower] ?? match;
  });
}

function oneLine(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Takes out what never belongs in an email: scripts, frames, forms and embedded objects. */
export function stripActive(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|base)\b[^>]*\/?>/gi, '');
}

/** Puts `snippet` right after <head> (or makes a head, or puts it first). */
export function addToHead(html: string, snippet: string): string {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (open) => `${open}${snippet}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${snippet}</head>`);
  return `${snippet}${html}`;
}

/** Puts `snippet` right after the opening <body> tag, or at the start. */
export function addAfterBodyOpen(html: string, snippet: string): string {
  return /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (open) => `${open}${snippet}`) : `${snippet}${html}`;
}

/** Puts `snippet` right before the last </body>, or at the end. */
export function addBeforeBodyClose(html: string, snippet: string): string {
  const at = html.toLowerCase().lastIndexOf('</body');
  return at < 0 ? `${html}${snippet}` : `${html.slice(0, at)}${snippet}${html.slice(at)}`;
}

/** Rewrites every href="…" through `map` (the value arrives decoded and leaves escaped). */
export function mapHrefs(html: string, map: (href: string) => string): string {
  return html.replace(/(\shref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (_match, prefix: string, double?: string, single?: string) => {
    const href = decodeEntities(double ?? single ?? '');
    return `${prefix}"${map(href).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  });
}

/** The words of an email for its plain-text part: links written out after their words. */
export function textOf(html: string): string {
  let body = html
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<(style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    // The hidden preview line is for inbox lists, not the text part.
    .replace(/<div\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div\s*>/gi, '');
  body = body.replace(/<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d?: string, s?: string, inner?: string) => {
    const words = oneLine(inner ?? '');
    const href = decodeEntities(d ?? s ?? '');
    if (!href || href.startsWith('#')) return words;
    return words ? `${words} (${href})` : href;
  });
  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|table|li|ul|ol)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the text looks like an HTML page or fragment rather than plain words. */
export function looksLikeHtml(value: string): boolean {
  return /<([a-z][a-z0-9]*)\b[^>]*>/i.test(value);
}
