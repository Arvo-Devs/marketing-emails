// One marketing email, drawn the way it goes out: the HTML part, the plain
// text part and the subject. The sender uses it for every person, and the
// page uses it for the preview, so what the editor shows is what arrives.
//
// Two kinds:
// - A written email is HTML someone pasted (usually made with the page's
//   prompt). Scripts, frames and forms are taken out, the site's own links
//   are tagged for Traffic, and the hidden preview line and the footer are
//   added. The pasted HTML never has to carry the footer: it is added here,
//   every time.
// - A roundup is drawn here from What's New posts: each post's title, its
//   one line and its picture, with a link to read it on What's New.
//
// Every email ends with why the person got it, a link to unsubscribe and the
// company's postal address: the law (CAN-SPAM) asks for the last two in
// every marketing email.
import type { EmailBrand, PostView } from './api';
import { addAfterBodyOpen, addBeforeBodyClose, mapHrefs, stripActive, textOf } from './html';
import { blocksToHtml, blocksToPlain, escapeHtml, parseText, type HtmlStyles } from './text';

export type RoundupPost = Pick<PostView, 'id' | 'title' | 'summary' | 'coverUrl'>;

export type HtmlEmailContent = Readonly<{ kind: 'feature'; subject: string; preheader: string; html: string }>;

export type RoundupContent = Readonly<{
  kind: 'roundup';
  subject: string;
  preheader: string;
  headline: string;
  /** A line at the top, in the simple text rules (../shared/text). */
  body: string;
  posts: readonly RoundupPost[];
}>;

export type EmailContent = HtmlEmailContent | RoundupContent;

export type RenderedEmail = Readonly<{ subject: string; html: string; text: string }>;

export type RenderOptions = Readonly<{
  /** The person's own unsubscribe address. */
  unsubscribeUrl: string;
  /** Names the email in the links' utm_campaign. */
  campaign: string;
  /** A test: a line at the top says only the sender got it. */
  test?: boolean;
}>;

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#111827';
const BODY = '#374151';
const QUIET = '#6b7280';
const LINE = '#e5e7eb';
const PAPER = '#f4f4f5';

/** The subject a roundup goes out with when none was written. */
export function roundupSubject(brand: Pick<EmailBrand, 'name'>, posts: readonly Pick<RoundupPost, 'title'>[]): string {
  if (posts.length === 1 && posts[0]) return `New in ${brand.name}: ${posts[0].title}`;
  return `What's new in ${brand.name}`;
}

/** The headline a roundup opens with when none was written. */
export function roundupHeadline(posts: readonly unknown[]): string {
  return posts.length === 1 ? "Here's what's new" : `${posts.length} new things to try`;
}

/** A brand color the email can use: #rgb or #rrggbb, else near-black. */
export function brandColor(value: string | null | undefined): string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : INK;
}

/** White or near-black text, whichever reads on the color. */
export function textOn(color: string): string {
  let hex = color.replace('#', '');
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? INK : '#ffffff';
}

/** "stop-answering-the-same-question", for utm_campaign. */
export function campaignName(content: Pick<EmailContent, 'kind' | 'subject'>, at: Date): string {
  if (content.kind === 'roundup') return `whats-new-${at.toISOString().slice(0, 10)}`;
  const slug = content.subject
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'email';
}

/** The address a link goes to: a path made full on the site, and the site's own links tagged for Traffic. */
export function linkFor(href: string, brand: Pick<EmailBrand, 'siteUrl'>, campaign: string): string {
  const value = href.trim();
  if (!value || value.startsWith('#') || /^(mailto|tel):/i.test(value)) return href;
  let url: URL;
  let site: URL;
  try {
    site = new URL(brand.siteUrl);
    url = new URL(value, site);
  } catch {
    return href;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return href;
  const own = url.hostname === site.hostname || url.hostname.endsWith(`.${site.hostname.replace(/^www\./, '')}`);
  if (own && !url.searchParams.has('utm_source')) {
    url.searchParams.set('utm_source', 'email');
    url.searchParams.set('utm_medium', 'email');
    url.searchParams.set('utm_campaign', campaign);
  }
  return url.href;
}

/** The grey line inboxes show after the subject: what was written, else the start of the words, else a roundup's post titles. */
export function previewText(content: EmailContent): string {
  const written = content.preheader.trim();
  if (written) return written;
  const words = content.kind === 'feature' ? textOf(content.html).replace(/\s+/g, ' ') : content.posts.map((p) => p.title).join(' · ');
  return words.slice(0, 120);
}

/** The hidden line inbox lists show after the subject, padded so the email's first words don't follow it. */
function preheaderBlock(text: string): string {
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(text)}${'&#8199;&#65279;&#847; '.repeat(40)}</div>`;
}

function testStrip(): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef3c7;"><tr>` +
    `<td align="center" style="padding:10px 16px;font-family:${FONT};font-size:13px;color:#92400e;">Test email: only you got this.</td></tr></table>`
  );
}

/** The footer every email ends with, on its own grey band so it reads on any email. */
export function footerHtml(brand: Pick<EmailBrand, 'name' | 'postalAddress'>, unsubscribeUrl: string): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};"><tr>` +
    `<td align="center" style="padding:20px 16px 28px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;"><tr>` +
    `<td style="font-family:${FONT};font-size:12px;line-height:1.6;color:${QUIET};text-align:center;">` +
    `You're getting this because you have an account with ${escapeHtml(brand.name)}. ` +
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:${QUIET};text-decoration:underline;">Unsubscribe</a><br>${escapeHtml(brand.postalAddress)}` +
    `</td></tr></table></td></tr></table>`
  );
}

function footerText(brand: Pick<EmailBrand, 'name' | 'postalAddress'>, unsubscribeUrl: string): string {
  return ['--', `You're getting this because you have an account with ${brand.name}.`, `Unsubscribe: ${unsubscribeUrl}`, brand.postalAddress].join('\n');
}

function styles(color: string, size: number): HtmlStyles {
  return {
    p: `margin:0 0 14px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${BODY};`,
    ul: `margin:0 0 14px;padding:0 0 0 22px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${BODY};`,
    li: 'margin:0 0 6px;',
    a: `color:${color};text-decoration:underline;`,
    strong: `font-weight:600;color:${INK};`,
  };
}

/** A link drawn as a button the way email apps all show it. */
export function buttonHtml(label: string, href: string, color: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;"><tr>` +
    `<td style="border-radius:8px;background:${color};">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;color:${textOn(color)};text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function picture(url: string, alt: string): string {
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" width="496" style="display:block;width:100%;max-width:496px;height:auto;margin:0 0 20px;border:0;border-radius:8px;">`;
}

/** The top of the email: the logo, or the name in bold. */
export function logoHtml(brand: Pick<EmailBrand, 'name' | 'logoUrl'>): string {
  return brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="28" style="display:block;height:28px;width:auto;border:0;">`
    : `<span style="font-family:${FONT};font-size:16px;font-weight:700;color:${INK};">${escapeHtml(brand.name)}</span>`;
}

/** A whole email document around `inner`: the grey page, the white column with the logo, and nothing else (the footer is added when it is drawn). */
export function emailDocument(brand: Pick<EmailBrand, 'name' | 'logoUrl'>, title: string, inner: string): string {
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};"><tr><td align="center" style="padding:28px 12px 0;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">` +
    `<tr><td style="padding:28px 32px 0;">${logoHtml(brand)}</td></tr>` +
    `<tr><td style="padding:22px 32px 30px;">${inner}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

function roundupDocument(content: RoundupContent, brand: EmailBrand, link: (href: string) => string, subject: string): { html: string; text: string[] } {
  const color = brandColor(brand.color);
  const headline = content.headline.trim() || roundupHeadline(content.posts);
  const intro = parseText(content.body);
  const parts: string[] = [`<h1 style="margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(headline)}</h1>`];
  const plain: string[] = [headline, ''];
  if (intro.length) {
    parts.push(blocksToHtml(intro, styles(color, 16), link));
    plain.push(blocksToPlain(intro, link), '');
  }
  for (const post of content.posts) {
    const target = link(`${brand.pageUrl}#post-${post.id}`);
    parts.push(
      `<div style="margin:22px 0 0;padding:22px 0 0;border-top:1px solid ${LINE};">` +
        (post.coverUrl ? picture(post.coverUrl, post.title) : '') +
        `<h2 style="margin:0 0 8px;font-family:${FONT};font-size:18px;line-height:1.35;font-weight:700;color:${INK};">${escapeHtml(post.title)}</h2>` +
        (post.summary ? `<p style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BODY};">${escapeHtml(post.summary)}</p>` : '') +
        `<p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;"><a href="${escapeHtml(target)}" style="color:${color};font-weight:600;text-decoration:none;">Read it &rarr;</a></p>` +
        `</div>`,
    );
    plain.push(`* ${post.title}`, ...(post.summary ? [post.summary] : []), `Read it: ${target}`, '');
  }
  parts.push(`<div style="margin:28px 0 0;">${buttonHtml('See everything new', link(brand.pageUrl), color)}</div>`);
  plain.push(`See everything new: ${link(brand.pageUrl)}`);
  return { html: emailDocument(brand, subject, parts.join('')), text: plain };
}

/** Draws one email for one person. */
export function renderEmail(content: EmailContent, brand: EmailBrand, options: RenderOptions): RenderedEmail {
  const link = (href: string) => linkFor(href, brand, options.campaign);
  const subject = content.subject.trim() || (content.kind === 'roundup' ? roundupSubject(brand, content.posts) : brand.name);
  let html: string;
  let text: string;
  if (content.kind === 'roundup') {
    const drawn = roundupDocument(content, brand, link, subject);
    html = drawn.html;
    text = drawn.text.join('\n');
  } else {
    html = stripActive(content.html.trim());
    // A fragment (no <html>) gets a page around it, so the footer and the preview line have a body to go in.
    if (!/<html\b/i.test(html)) {
      html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;">${html}</body></html>`;
    }
    html = mapHrefs(html, link);
    text = textOf(html);
  }
  html = addAfterBodyOpen(html, `${options.test ? testStrip() : ''}${preheaderBlock(previewText(content))}`);
  html = addBeforeBodyClose(html, footerHtml(brand, options.unsubscribeUrl));
  const plain = [options.test ? '[Test email: only you got this]\n' : '', text, '', footerText(brand, options.unsubscribeUrl)].join('\n');
  return { subject: options.test ? `[Test] ${subject}` : subject, html, text: `${plain.replace(/\n{3,}/g, '\n\n').trim()}\n` };
}

/** A starting email in the shape the email prompt asks for: the column, a picture, a headline, a few lines and one button. No footer: drawing adds it. */
export function featureHtml(
  feature: Readonly<{ subject: string; headline: string; body: string; imageUrl: string | null; buttonLabel: string | null; buttonUrl: string | null }>,
  brand: Pick<EmailBrand, 'name' | 'logoUrl' | 'color'>,
): string {
  const color = brandColor(brand.color);
  const keep = (href: string) => href;
  const parts: string[] = [];
  if (feature.imageUrl) parts.push(picture(feature.imageUrl, feature.headline || feature.subject));
  if (feature.headline) parts.push(`<h1 style="margin:0 0 14px;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(feature.headline)}</h1>`);
  parts.push(blocksToHtml(parseText(feature.body), styles(color, 16), keep));
  if (feature.buttonLabel && feature.buttonUrl) parts.push(buttonHtml(feature.buttonLabel, feature.buttonUrl, color));
  return emailDocument(brand, feature.subject, parts.join(''));
}
