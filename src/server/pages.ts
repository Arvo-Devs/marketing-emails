// The small public pages a person reaches from an email's Unsubscribe link.
// Plain HTML with its own styles: the person may not be signed in, and the
// app's layout is not around these routes.
//
// GET only shows a button, because mail scanners open every link in an
// email and must never unsubscribe anyone by doing so. The button posts the
// form back. Inboxes' own Unsubscribe buttons (List-Unsubscribe-Post) post
// "List-Unsubscribe=One-Click" and are done in one step.
import { escapeHtml } from '../shared/text';

export type PageWords = Readonly<{ title: string; lines: readonly string[]; button?: Readonly<{ label: string; action: 'unsubscribe' | 'resubscribe' }> }>;

export function htmlPage(brandName: string, words: PageWords, status = 200): Response {
  const lines = words.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  const form = words.button
    ? `<form method="post"><input type="hidden" name="action" value="${words.button.action}"><button type="submit">${escapeHtml(words.button.label)}</button></form>`
    : '';
  const body =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(words.title)} · ${escapeHtml(brandName)}</title>` +
    `<style>` +
    `:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--ink:#111827;--quiet:#4b5563;--line:#e5e7eb;--btn:#111827;--btn-ink:#fff}` +
    `@media (prefers-color-scheme:dark){:root{--bg:#0b0b12;--card:#16161f;--ink:#f3f4f6;--quiet:#a1a1aa;--line:#27272f;--btn:#f3f4f6;--btn-ink:#111827}}` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--ink)}` +
    `main{box-sizing:border-box;width:min(440px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}` +
    `.brand{margin:0 0 18px;font-size:13px;font-weight:600;color:var(--quiet)}h1{margin:0 0 10px;font-size:20px;line-height:1.3}` +
    `p{margin:0 0 10px;font-size:15px;line-height:1.55;color:var(--quiet)}form{margin:18px 0 0}` +
    `button{appearance:none;border:0;border-radius:10px;background:var(--btn);color:var(--btn-ink);font:inherit;font-weight:600;font-size:15px;padding:11px 18px;cursor:pointer;width:100%}` +
    `</style></head><body><main><p class="brand">${escapeHtml(brandName)}</p><h1>${escapeHtml(words.title)}</h1>${lines}${form}</main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

export const UNSUBSCRIBE_WORDS = {
  ask: (brand: string): PageWords => ({
    title: `Stop marketing emails from ${brand}?`,
    lines: [`You'll stop getting news and tips from ${brand}. Emails about your account, like receipts and sign-in codes, still come.`],
    button: { label: 'Unsubscribe', action: 'unsubscribe' },
  }),
  done: (brand: string): PageWords => ({
    title: "You're unsubscribed",
    lines: [`You won't get marketing emails from ${brand} anymore.`, 'Changed your mind?'],
    button: { label: 'Subscribe again', action: 'resubscribe' },
  }),
  back: (brand: string): PageWords => ({
    title: "You're subscribed again",
    lines: [`You'll get news and tips from ${brand} again. Every email has a link to stop them.`],
  }),
  test: (): PageWords => ({
    title: 'This was a test email',
    lines: ['Only the person who sent the test got it, so there is nothing to unsubscribe from.'],
  }),
  unknown: (): PageWords => ({
    title: "This link doesn't work anymore",
    lines: ['You can turn marketing emails off in your account settings, or reply to the email and ask.'],
  }),
  failed: (): PageWords => ({
    title: "That didn't go through",
    lines: ['Try the link again in a minute. If it keeps failing, reply to the email and ask to be taken off the list.'],
  }),
} as const;
