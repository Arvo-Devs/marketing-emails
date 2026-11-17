// The simple text rules (a roundup's line at the top), the HTML helpers
// (what is read from a pasted page and what is added to it), and the email
// they become: the footer and the preview line are always added, scripts
// never reach an email, the site's own links are tagged for Traffic and
// outside links are left alone.
import { describe, expect, test } from 'bun:test';
import type { EmailBrand } from '../src/shared/api';
import { brandColor, campaignName, featureHtml, linkFor, previewText, renderEmail, roundupSubject, textOn } from '../src/shared/email';
import { EMAIL_EXAMPLES, EXAMPLE_BRAND, exampleContent } from '../src/shared/examples';
import { addBeforeBodyClose, mapHrefs, stripActive, textOf } from '../src/shared/html';
import { emailPrompt } from '../src/shared/prompts';
import { parseText, safeHref } from '../src/shared/text';
import { sniffImage } from '../src/server/images';

describe('parseText', () => {
  test('paragraphs, a line break, bullets, bold and a link', () => {
    const blocks = parseText('Hello **you**\nsecond line\n\n- one\n- [two](https://example.com/x)\n\nlast');
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'list', 'p']);
    expect(blocks[0]).toEqual({ kind: 'p', inlines: [{ kind: 'text', text: 'Hello ' }, { kind: 'bold', text: 'you' }, { kind: 'br' }, { kind: 'text', text: 'second line' }] });
  });

  test('links that could run script stay plain words', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('/settings')).toBe('/settings');
  });
});

describe('changing pasted HTML', () => {
  test('what never goes in an email is taken out', () => {
    const out = stripActive('<p>a</p><script>x()</script><SCRIPT src="y.js"></SCRIPT><iframe src="z"></iframe><form><input></form><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });

  test('the footer goes before the last </body>, or at the end', () => {
    expect(addBeforeBodyClose('<body><p>x</p></body></html>', 'F')).toBe('<body><p>x</p>F</body></html>');
    expect(addBeforeBodyClose('<p>x</p>', 'F')).toBe('<p>x</p>F');
  });

  test('links rewritten, escaped going back in', () => {
    expect(mapHrefs(`<a href="/a?x=1&amp;y=2">A</a><a href='b'>B</a>`, (h) => `${h}&z`)).toBe('<a href="/a?x=1&amp;y=2&amp;z">A</a><a href="b&amp;z">B</a>');
  });

  test('the text part: words, links written out, no hidden preview line', () => {
    const text = textOf('<html><head><title>T</title><style>p{}</style></head><body><div style="display:none">hidden</div><h1>Hi</h1><p>Go <a href="https://x.example/a">here</a>.</p><ul><li>one</li><li>two</li></ul></body></html>');
    expect(text).toContain('Hi');
    expect(text).toContain('Go here (https://x.example/a).');
    expect(text).toContain('- one');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('p{}');
  });
});

const BRAND: EmailBrand = {
  name: 'Acme <Tools>',
  logoUrl: null,
  color: '#ffcc00',
  siteUrl: 'https://acme.example',
  postalAddress: '1 Main St, Springfield',
  pageUrl: 'https://acme.example/whats-new',
};

describe('renderEmail: a pasted email', () => {
  const pasted = {
    kind: 'feature' as const,
    subject: 'Saved replies are here',
    preheader: '',
    html: '<!DOCTYPE html><html><head><title>x</title></head><body><h1>Answer in one click</h1><p>See <a href="/help/replies">the guide</a> or <a href="https://partner.example/x">our partner</a>.</p><script>alert(1)</script></body></html>',
  };

  test('the footer, the address and the preview line are added; scripts are not sent', () => {
    const out = renderEmail(pasted, BRAND, { unsubscribeUrl: 'https://acme.example/api/whats-new/unsubscribe?t=tok', campaign: 'saved-replies' });
    expect(out.html).not.toContain('<script');
    expect(out.html).toContain('href="https://acme.example/api/whats-new/unsubscribe?t=tok"');
    expect(out.html).toContain('Acme &lt;Tools&gt;');
    expect(out.html).toContain('1 Main St, Springfield');
    expect(out.html.indexOf('Answer in one click')).toBeLessThan(out.html.indexOf('Unsubscribe'));
    expect(out.html).toContain('display:none');
    expect(out.text).toContain('Unsubscribe: https://acme.example/api/whats-new/unsubscribe?t=tok');
    expect(out.subject).toBe('Saved replies are here');
  });

  test("the site's links are full and tagged; other sites' are not", () => {
    const out = renderEmail(pasted, BRAND, { unsubscribeUrl: 'u', campaign: 'saved-replies' });
    expect(out.html).toContain('href="https://acme.example/help/replies?utm_source=email&amp;utm_medium=email&amp;utm_campaign=saved-replies"');
    expect(out.html).toContain('href="https://partner.example/x"');
    expect(linkFor('https://app.acme.example/x', BRAND, 'c')).toContain('utm_campaign=c');
    expect(linkFor('https://acme.example/x?utm_source=ads', BRAND, 'c')).toBe('https://acme.example/x?utm_source=ads');
    expect(linkFor('mailto:help@acme.example', BRAND, 'c')).toBe('mailto:help@acme.example');
  });

  test('a fragment gets a page around it, so the footer still has a body to go in', () => {
    const out = renderEmail({ kind: 'feature', subject: 'S', preheader: 'P', html: '<p>Just this</p>' }, BRAND, { unsubscribeUrl: 'u', campaign: 'c' });
    expect(out.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.html).toContain('<p>Just this</p>');
    expect(out.html).toContain('Unsubscribe');
  });

  test('the preview line: written, else the first words', () => {
    expect(previewText({ ...pasted, preheader: 'Written' })).toBe('Written');
    expect(previewText(pasted).startsWith('Answer in one click')).toBe(true);
  });

  test('a test says so in the subject and at the top', () => {
    const out = renderEmail(pasted, BRAND, { unsubscribeUrl: 'u', campaign: 'c', test: true });
    expect(out.subject).toBe('[Test] Saved replies are here');
    expect(out.html).toContain('Test email: only you got this.');
  });

  test('colors', () => {
    expect(textOn('#ffcc00')).toBe('#111827');
    expect(textOn('#4f46e5')).toBe('#ffffff');
    expect(brandColor('red')).toBe('#111827');
  });
});

describe('renderEmail: a roundup', () => {
  test('each post: title, one line, picture, and a link to read it; no words written means words of its own', () => {
    const posts = [
      { id: 'p1', title: 'Dark mode', summary: 'Easier at night.', coverUrl: 'https://acme.example/api/whats-new/images/i1' },
      { id: 'p2', title: 'Exports', summary: '', coverUrl: null },
    ];
    const out = renderEmail({ kind: 'roundup', subject: '', preheader: '', headline: '', body: '', posts }, BRAND, { unsubscribeUrl: 'u', campaign: 'whats-new-2026-11-24' });
    expect(out.subject).toBe('What\'s new in Acme <Tools>');
    expect(out.html).toContain('2 new things to try');
    expect(out.html).toContain('Easier at night.');
    expect(out.html).toContain('src="https://acme.example/api/whats-new/images/i1"');
    expect(out.html).toContain('https://acme.example/whats-new?utm_source=email&amp;utm_medium=email&amp;utm_campaign=whats-new-2026-11-24#post-p1');
    expect(out.html).toContain('Dark mode · Exports');
    expect(roundupSubject({ name: 'X' }, [{ title: 'Dark mode' }])).toBe('New in X: Dark mode');
  });

  test('the line typed at the top stays words: nothing typed becomes HTML', () => {
    const out = renderEmail(
      { kind: 'roundup', subject: '', preheader: '', headline: '<b>Big</b>', body: 'Hi <script>alert(1)</script> **there**', posts: [{ id: 'p1', title: '<i>x</i>', summary: '<img src=x>', coverUrl: null }] },
      BRAND,
      { unsubscribeUrl: 'u', campaign: 'c' },
    );
    expect(out.html).not.toContain('<script');
    expect(out.html).toContain('Hi &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('&lt;b&gt;Big&lt;/b&gt;');
    expect(out.html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(out.html).toContain('&lt;img src=x&gt;');
    expect(out.html).toContain('<strong');
  });
});

describe('examples and prompts', () => {
  test('every example draws, and "Use this" draws it in the app\'s own name', () => {
    for (const example of EMAIL_EXAMPLES) {
      const out = renderEmail(exampleContent(example, EXAMPLE_BRAND), EXAMPLE_BRAND, { unsubscribeUrl: 'u', campaign: 'c' });
      expect(out.html.length).toBeGreaterThan(1000);
      expect(out.text).toContain('Unsubscribe: u');
    }
    const used = featureHtml(EMAIL_EXAMPLES[0]!.feature!, { name: 'Northwind', logoUrl: null, color: '#0f766e' });
    expect(used).toContain('Northwind');
    expect(used).toContain('background:#0f766e');
    // The page adds the footer, so a starting email has none.
    expect(used).not.toContain('Unsubscribe');
  });

  test('the prompt names the app and its site, and tells the AI what the page adds', () => {
    const email = emailPrompt({ appName: 'Northwind', siteUrl: 'https://northwind.example' });
    expect(email).toContain('Make a marketing email for Northwind.');
    expect(email).toContain('No unsubscribe link, no postal address');
    expect(email).toContain('https://northwind.example');
    expect(email).not.toMatch(/[\u2013\u2014]/);
  });

  test('campaign names', () => {
    expect(campaignName({ kind: 'feature', subject: 'Stop typing the same answer twice!' }, new Date())).toBe('stop-typing-the-same-answer-twice');
    expect(campaignName({ kind: 'roundup', subject: '' }, new Date('2026-11-24T18:00:00Z'))).toBe('whats-new-2026-11-24');
  });
});

describe('sniffImage', () => {
  test('by the first bytes, never the name', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
});
