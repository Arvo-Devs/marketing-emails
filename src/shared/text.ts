// The text of a post or an email, written the simple way people write a
// message, and read the same way everywhere it shows (the pop-up, the What's
// New page, the email, the plain-text email):
//
//   A blank line starts a new paragraph. A single line break stays one.
//   A line that starts with "- " (or "* ", "• ") is a bullet.
//   **two stars** around words make them bold.
//   [words](https://example.com) is a link. A link may also be a path on the
//   site (/settings) or a mailto: address. Anything else stays plain text.
//
// Nothing written here can add HTML: every character is escaped where HTML
// is made. Imports nothing from Node or React.

export type Inline =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'bold'; text: string }>
  | Readonly<{ kind: 'link'; text: string; href: string }>
  | Readonly<{ kind: 'br' }>;

export type Block = Readonly<{ kind: 'p'; inlines: readonly Inline[] }> | Readonly<{ kind: 'list'; items: readonly (readonly Inline[])[] }>;

const BULLET = /^\s*(?:[-*•])\s+/;

/** A link the text may carry: https or http, mailto, or a path on the site ("/settings"). Null for anything else. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  if (!value || value.length > 2000) return null;
  if (value.startsWith('/')) return value.startsWith('//') || value.includes('\\') ? null : value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  if (url.protocol === 'mailto:') return value;
  return null;
}

function inlinesOf(line: string): Inline[] {
  const out: Inline[] = [];
  // **bold** or [label](href), whichever comes first.
  const pattern = /\*\*([^*\n]+?)\*\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g;
  let last = 0;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > last) out.push({ kind: 'text', text: line.slice(last, match.index) });
    if (match[1] !== undefined) {
      out.push({ kind: 'bold', text: match[1] });
    } else {
      const href = safeHref(match[3] ?? '');
      out.push(href ? { kind: 'link', text: match[2] ?? '', href } : { kind: 'text', text: match[2] ?? '' });
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

/** Splits the text into paragraphs and bullet lists. Empty text is no blocks. */
export function parseText(source: string): Block[] {
  const blocks: Block[] = [];
  const chunks = source.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    let paragraph: string[] = [];
    let items: string[] = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const inlines: Inline[] = [];
      paragraph.forEach((line, i) => {
        if (i > 0) inlines.push({ kind: 'br' });
        inlines.push(...inlinesOf(line.trim()));
      });
      blocks.push({ kind: 'p', inlines });
      paragraph = [];
    };
    const flushItems = () => {
      if (!items.length) return;
      blocks.push({ kind: 'list', items: items.map((item) => inlinesOf(item)) });
      items = [];
    };
    for (const line of lines) {
      if (BULLET.test(line)) {
        flushParagraph();
        items.push(line.replace(BULLET, '').trim());
      } else {
        flushItems();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushItems();
  }
  return blocks;
}

/** The text with its marks taken out, for a short line (a preview, an alt text). */
export function plainText(source: string): string {
  return parseText(source)
    .map((block) => (block.kind === 'p' ? inlineText(block.inlines) : block.items.map((item) => inlineText(item)).join(' ')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inlineText(inlines: readonly Inline[]): string {
  return inlines.map((inline) => (inline.kind === 'br' ? ' ' : inline.text)).join('');
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export type HtmlStyles = Readonly<{ p: string; ul: string; li: string; a: string; strong: string }>;

/** The blocks as email-safe HTML with inline styles. `resolve` turns a link into the address that goes out. */
export function blocksToHtml(blocks: readonly Block[], styles: HtmlStyles, resolve: (href: string) => string): string {
  const inline = (inlines: readonly Inline[]) =>
    inlines
      .map((item) => {
        if (item.kind === 'br') return '<br>';
        if (item.kind === 'bold') return `<strong style="${styles.strong}">${escapeHtml(item.text)}</strong>`;
        if (item.kind === 'link') return `<a href="${escapeHtml(resolve(item.href))}" style="${styles.a}">${escapeHtml(item.text)}</a>`;
        return escapeHtml(item.text);
      })
      .join('');
  return blocks
    .map((block) =>
      block.kind === 'p'
        ? `<p style="${styles.p}">${inline(block.inlines)}</p>`
        : `<ul style="${styles.ul}">${block.items.map((item) => `<li style="${styles.li}">${inline(item)}</li>`).join('')}</ul>`,
    )
    .join('');
}

/** The blocks as plain text for the text part of an email: links written out after their words. */
export function blocksToPlain(blocks: readonly Block[], resolve: (href: string) => string): string {
  const inline = (inlines: readonly Inline[]) =>
    inlines
      .map((item) => {
        if (item.kind === 'br') return '\n';
        if (item.kind === 'link') return `${item.text} (${resolve(item.href)})`;
        return item.text;
      })
      .join('');
  return blocks.map((block) => (block.kind === 'p' ? inline(block.inlines) : block.items.map((item) => `- ${inline(item)}`).join('\n'))).join('\n\n');
}
