/**
 * Marketing emails against a real Postgres, through createMarketingEmails and a
 * pretend app (fake-app.ts) whose sender is an outbox: the line and the
 * roundup, a slot taking one email, everyone getting each email once (with
 * two servers sending at once, and after a crash), the pause when the email
 * service refuses everything, stopping, unsubscribing from the link and from
 * the app's settings, tests, and the page's own answer. Runs only with
 * MARKETING_TEST_PG_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createMarketingEmails, type MarketingEmails } from '../src/index';
import type { MarketingRecipient } from '../src/config';
import type { ManageEmailsAnswer, MyEmailsAnswer } from '../src/shared/api';
import { addPost, cookieFor, fakeConfig, migrate, outbox, request, slotDue, type Outbox } from './fake-app';

const ROOT_URL = process.env.MARKETING_TEST_PG_URL ?? '';

describe.skipIf(!ROOT_URL)('Marketing emails (pg)', () => {
  const database = `whats_new_mail_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let out: Outbox;
  let people: MarketingRecipient[];
  let app: MarketingEmails;
  const make = (extra: Partial<Parameters<typeof fakeConfig>[0]> = {}) =>
    createMarketingEmails(fakeConfig({ db: () => sql, out, recipients: async () => people, ...extra }), { sleep: async () => undefined });

  const post = (path: string, body: unknown, who = 'admin') => app.routeHandlers.POST(request(path, { cookie: cookieFor(who), body }));
  const page = async () => {
    const response = await app.routeHandlers.GET(request('/api/marketing-emails/manage', { cookie: cookieFor('admin') }));
    expect(response.status).toBe(200);
    return (await response.json()) as ManageEmailsAnswer;
  };
  const emailHtml = (words: string) =>
    `<!DOCTYPE html><html><head><title>${words}</title></head><body><table><tr><td><h1>${words}</h1><p>Hi.</p><a href="/x">Go</a> <a href="https://partner.example/y">Partner</a></td></tr></table></body></html>`;
  const newEmail = async (subject: string, extra: Record<string, unknown> = {}) => {
    const response = await post('/api/marketing-emails/manage/emails', { kind: 'feature', subject, html: emailHtml(subject), ...extra });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  /** A live What's New post, as @arvo/whats-new keeps it, a moment newer than the last. */
  let postClock = Date.now() - 60_000;
  const newPost = (title: string, extra: Parameters<typeof addPost>[2] = {}) => {
    postClock += 1000;
    return addPost(sql, title, { publishedAt: new Date(Math.min(postClock, Date.now() - 1000)), ...extra });
  };
  const deliveries = async (emailId: string) =>
    (await sql<{ user_id: string; status: string }[]>`select user_id, status from marketing_deliveries where email_id = ${emailId} order by user_id`).map((r) => `${r.user_id}:${r.status}`);
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from marketing_emails where id = ${id}`)[0]?.status;
  const many = (n: number): MarketingRecipient[] => Array.from({ length: n }, (_, i) => ({ id: `usr_${String(i).padStart(3, '0')}`, email: `p${i}@example.test` }));

  beforeAll(async () => {
    admin = postgres(ROOT_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const url = new URL(ROOT_URL);
    url.pathname = `/${database}`;
    sql = postgres(url.href, { max: 8, onnotice: () => {} });
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists ${database} with (force)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`truncate whats_new_posts, marketing_images, marketing_roundup_posts, marketing_emails, marketing_deliveries, marketing_unsubscribes, marketing_settings`;
    out = outbox();
    people = [
      { id: 'usr_agency', email: 'agency@example.test', audiences: ['agency'] },
      { id: 'usr_creator', email: 'creator@example.test', audiences: ['creator'] },
      { id: 'usr_other', email: 'other@example.test' },
    ];
    app = make();
  });

  test('nothing goes out while sending is off, the way a new install starts', async () => {
    await newEmail('Hello');
    expect((await page()).settings.sending).toBe(false);
    expect((await app.sendDue()).state).toBe('off');
    expect(out.sent).toEqual([]);
  });

  test('a due slot takes the first email in line and sends it to everyone, once', async () => {
    const first = await newEmail('First');
    const second = await newEmail('Second');
    await slotDue(sql, 2);
    const pass = await app.sendDue();
    expect(pass).toMatchObject({ state: 'sent', email: first, sent: 3, failed: 0 });
    expect(out.sent.map((e) => e.to).sort()).toEqual(['agency@example.test', 'creator@example.test', 'other@example.test']);
    expect(out.sent.every((e) => e.subject === 'First' && e.from === 'Example App <updates@app.example.com>' && e.replyTo === 'support@app.example.com')).toBe(true);
    expect(await statusOf(first)).toBe('sent');
    expect(await statusOf(second)).toBe('queued');

    // The slot is used: the next pass sends nothing until the next slot.
    expect((await app.sendDue()).state).toBe('nothing_due');
    expect(out.sent).toHaveLength(3);
    await slotDue(sql, 1);
    expect((await app.sendDue()).email).toBe(second);
    expect(out.sent).toHaveLength(6);
  });

  test('every email carries its own unsubscribe link, in the body and the headers', async () => {
    await newEmail('Hello');
    await slotDue(sql, 2);
    await app.sendDue();
    const tokens = new Set<string>();
    for (const email of out.sent) {
      const header = email.headers['List-Unsubscribe'] ?? '';
      const url = /^<(.+)>$/.exec(header)?.[1] ?? '';
      expect(url.startsWith('https://app.example.com/api/marketing-emails/unsubscribe?t=')).toBe(true);
      expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(email.html).toContain(url.replace(/&/g, '&amp;'));
      expect(email.text).toContain('1 Example Way, Testville');
      tokens.add(url);
    }
    expect(tokens.size).toBe(3);
  });

  test('outside production nothing goes out unless the setup says it is a test one', async () => {
    const base = fakeConfig({ db: () => sql, out, recipients: async () => people });
    const laptop = createMarketingEmails({ ...base, sendOutsideProduction: false }, { sleep: async () => undefined });
    await newEmail('Not from a laptop');
    await slotDue(sql, 2);
    expect(process.env.NODE_ENV).not.toBe('production');
    expect((await laptop.sendDue()).state).toBe('not_production');
    expect(out.sent).toEqual([]);
    // A test still reaches the person sending it.
    const test = await laptop.routeHandlers.POST(request('/api/marketing-emails/manage/test', { cookie: cookieFor('admin'), body: { kind: 'feature', subject: 'Hi', html: '<p>Hi</p>' } }));
    expect(test.status).toBe(200);
    expect(out.sent.map((e) => e.to)).toEqual(['admin@example.com']);
  });

  test('a written email goes out as pasted, with the footer, the preview line and tagged links added, and no script', async () => {
    await newEmail('Pasted', { preheader: 'The grey line', html: `<html><body><p>Hello</p><script>steal()</script><a href="/settings">Open</a><a href="https://partner.example/y">Partner</a></body></html>` });
    await slotDue(sql, 2);
    await app.sendDue();
    const email = out.sent.find((e) => e.to === 'agency@example.test')!;
    expect(email.subject).toBe('Pasted');
    expect(email.html).not.toContain('<script');
    expect(email.html).toContain('The grey line');
    expect(email.html).toContain('href="https://app.example.com/settings?utm_source=email&amp;utm_medium=email&amp;utm_campaign=pasted"');
    expect(email.html).toContain('href="https://partner.example/y"');
    expect(email.html).toContain("You're getting this because you have an account with Example App.");
    expect(email.html).toContain('1 Example Way, Testville');
    expect(email.html.indexOf('Unsubscribe')).toBeLessThan(email.html.indexOf('</body>'));
    expect(email.text).toContain('Open (https://app.example.com/settings?utm_source=email');
    expect(email.text).toContain('Unsubscribe: https://app.example.com/api/marketing-emails/unsubscribe?t=');
  });

  test('a roundup shows each post\'s title, one line and picture for the email, linked to the post', async () => {
    // The post's picture lives in What's New, served from its own address.
    const imageId = crypto.randomUUID();
    const postId = await newPost('With a picture', { coverImageId: imageId, summary: 'One line about it.' });
    await slotDue(sql, 2);
    await app.sendDue();
    const email = out.sent[0]!;
    expect(email.html).toContain('With a picture');
    expect(email.html).toContain('One line about it.');
    expect(email.html).toContain(`src="https://app.example.com/api/whats-new/images/${imageId}"`);
    expect(email.html).toContain(`dashboard/whats-new?utm_source=email&amp;utm_medium=email&amp;utm_campaign=whats-new-`);
    expect(email.html).toContain(`#post-${postId}`);
    // The post's own page never goes in the email.
    expect(email.html).not.toContain('<h1>With a picture</h1>');
  });

  test('only live posts with the roundup ticked wait for it: never drafts or scheduled ones', async () => {
    await newPost('Draft', { status: 'draft' });
    await newPost('Scheduled', { publishedAt: new Date(Date.now() + 3_600_000) });
    await newPost('Left out', { inEmail: false });
    let answer = await page();
    expect(answer.queue).toEqual([]);
    expect(answer.roundupPosts).toEqual([]);
    await newPost('Live');
    answer = await page();
    expect(answer.roundupPosts.map((p) => p.title)).toEqual(['Live']);
  });

  test('changes come only from the site\'s own pages; the unsubscribe link works from anywhere', async () => {
    const from = (path: string, body: unknown, origin: string) => app.routeHandlers.POST(request(path, { cookie: cookieFor('admin'), body, origin }));
    expect((await from('/api/marketing-emails/manage/settings', { sending: true }, 'https://evil.example')).status).toBe(403);
    expect((await from('/api/marketing-emails/manage/emails', { kind: 'feature', subject: 'x', html: '<p>x</p>' }, 'https://evil.example')).status).toBe(403);
    expect((await from('/api/marketing-emails/me/emails', { subscribed: false }, 'https://evil.example')).status).toBe(403);
    // Gmail's one-click button posts from its own servers.
    const oneClick = await app.routeHandlers.POST(request('/api/marketing-emails/unsubscribe?t=nope', { origin: 'https://mail.google.com', raw: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' }));
    expect(oneClick.status).toBe(404);
  });

  test('a big email (a few hundred KB of HTML) saves', async () => {
    const big = `<table>${'<tr><td style="padding:8px;font-family:Arial,sans-serif">made-up row</td></tr>'.repeat(4000)}</table>`;
    expect(big.length).toBeGreaterThan(250_000);
    expect((await post('/api/marketing-emails/manage/emails', { kind: 'feature', subject: 'Big', html: big })).status).toBe(201);
    expect((await post('/api/marketing-emails/manage/emails', { kind: 'feature', subject: 'Too big', html: `<p>${'x'.repeat(1_000_001)}</p>` })).status).toBe(400);
  });

  test('a slot more than six hours gone waits for the next one', async () => {
    await newEmail('Late');
    await slotDue(sql, 6 * 60 + 5);
    expect((await app.sendDue()).state).toBe('nothing_due');
    expect(out.sent).toEqual([]);
  });

  test('people who unsubscribed, bad addresses and the same address twice are left out; groups are kept to', async () => {
    // All in the group, so only the rule under test leaves each one out.
    people.push(
      { id: 'usr_twin', email: 'AGENCY@example.test', audiences: ['agency'] },
      { id: 'usr_bad', email: 'not-an-address', audiences: ['agency'] },
      { id: 'usr_gone', email: 'gone@example.test', audiences: ['agency'] },
    );
    await sql`insert into marketing_unsubscribes (user_id) values ('usr_gone')`;
    await newEmail('For agencies', { audience: ['agency'] });
    await slotDue(sql, 2);
    await app.sendDue();
    expect(out.sent.map((e) => e.to)).toEqual(['agency@example.test']);
  });

  test('a roundup joins the line when a post goes live, carries every waiting post, and each person gets only theirs', async () => {
    await newPost('Everyone gets this');
    await newPost('Agencies only', { audience: ['agency'] });
    await newPost('Kept out of email', { inEmail: false });
    const before = await page();
    expect(before.queue.map((e) => e.kind)).toEqual(['roundup']);
    expect(before.roundupPosts.map((p) => p.title).sort()).toEqual(['Agencies only', 'Everyone gets this']);

    await slotDue(sql, 2);
    const pass = await app.sendDue();
    expect(pass.state).toBe('sent');
    const byPerson = Object.fromEntries(out.sent.map((e) => [e.to, e]));
    expect(byPerson['agency@example.test']?.html).toContain('Agencies only');
    expect(byPerson['agency@example.test']?.html).toContain('Everyone gets this');
    expect(byPerson['creator@example.test']?.html).not.toContain('Agencies only');
    expect(byPerson['creator@example.test']?.subject).toBe('New in Example App: Everyone gets this');
    expect(out.sent.some((e) => e.html.includes('Kept out of email'))).toBe(false);

    // Its posts are marked as emailed; a post published after it went out waits for the next roundup.
    const emailed = await sql<{ title: string }[]>`select p.title from marketing_roundup_posts r join whats_new_posts p on p.id = r.post_id order by p.title`;
    expect(emailed.map((r) => r.title)).toEqual(['Agencies only', 'Everyone gets this']);
    await newPost('Next time');
    const after = await page();
    expect(after.queue.map((e) => e.kind)).toEqual(['roundup']);
    expect(after.roundupPosts.map((p) => p.title)).toEqual(['Next time']);
    // Sent without a written subject: the page shows the one people got.
    expect(after.sent[0]).toMatchObject({ kind: 'roundup', sent: 3, failed: 0, subject: "What's new in Example App" });
  });

  test('someone who may see none of a roundup\'s posts is skipped', async () => {
    await newPost('Creators only', { audience: ['creator'] });
    await slotDue(sql, 2);
    await app.sendDue();
    expect(out.sent.map((e) => e.to)).toEqual(['creator@example.test']);
  });

  test('a roundup whose posts went back to draft gives its slot to the next email', async () => {
    const postId = await newPost('Oops');
    const written = await newEmail('Written');
    await post(`/api/marketing-emails/manage/emails/${(await page()).queue.find((e) => e.kind === 'roundup')!.id}/move`, { direction: 'up' }).catch(() => undefined);
    // Unpublishing behind the page's back, then the slot comes.
    await sql`update whats_new_posts set status = 'draft' where id = ${postId}`;
    await slotDue(sql, 2);
    const pass = await app.sendDue();
    expect(pass.email).toBe(written);
    expect(out.sent.every((e) => e.subject === 'Written')).toBe(true);
  });

  test('two servers at once: one email in the slot', async () => {
    people = many(40);
    await newEmail('Only once');
    await newEmail('Not this slot');
    await slotDue(sql, 2);
    const other = make();
    const passes = await Promise.all([app.sendDue(), other.sendDue()]);
    expect(passes.map((p) => p.state)).toContain('sent');
    await app.sendDue();
    expect(out.sent.every((e) => e.subject === 'Only once')).toBe(true);
    expect((await sql`select 1 from marketing_emails where status <> 'queued'`).length).toBe(1);
  });

  test('two servers sending the same email at the same moment: nobody gets it twice', async () => {
    people = many(30);
    app = make({ sendMs: 3 });
    const other = make({ sendMs: 3 });
    await newEmail('Only once');
    await slotDue(sql, 2);
    const first = app.sendDue();
    // The second server starts while the first is part way through the list.
    for (let i = 0; i < 100 && out.sent.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = other.sendDue();
    const passes = await Promise.all([first, second]);
    expect(passes.every((p) => p.state === 'sent')).toBe(true);
    // Both really sent some of it.
    expect(passes.every((p) => p.sent > 0)).toBe(true);
    const to = out.sent.map((e) => e.to);
    expect(to).toHaveLength(30);
    expect(new Set(to).size).toBe(30);
  });

  test('a pass stops when its time is up, and the next passes finish the email, once each', async () => {
    people = many(20);
    app = make({ sendMs: 4 });
    const id = await newEmail('In pieces');
    await slotDue(sql, 2);
    const first = await app.sendDue({ budgetMs: 15 });
    expect(first.state).toBe('partial');
    expect(first.sent).toBeGreaterThan(0);
    expect(first.sent).toBeLessThan(20);
    expect(await statusOf(id)).toBe('sending');
    for (let i = 0; i < 20 && (await statusOf(id)) === 'sending'; i += 1) await app.sendDue({ budgetMs: 15 });
    expect(await statusOf(id)).toBe('sent');
    expect(out.sent).toHaveLength(20);
    expect(new Set(out.sent.map((e) => e.to)).size).toBe(20);
  });

  test('after a crash part way, the next pass sends only to the rest', async () => {
    people = many(10);
    const id = await newEmail('Resumed');
    await slotDue(sql, 2);
    // A server took the slot, reached three people, and died.
    await sql`update marketing_emails set status = 'sending', slot_at = now() - interval '2 minutes', started_at = now() where id = ${id}`;
    for (const person of people.slice(0, 3)) {
      await sql`insert into marketing_deliveries (email_id, user_id, status, token) values (${id}, ${person.id}, 'sent', ${crypto.randomUUID()})`;
    }
    // One was claimed but never confirmed, 20 minutes ago: it is marked failed, never sent again.
    await sql`insert into marketing_deliveries (email_id, user_id, status, token, updated_at) values (${id}, ${people[3]!.id}, 'sending', ${crypto.randomUUID()}, now() - interval '20 minutes')`;
    const pass = await app.sendDue();
    expect(pass).toMatchObject({ state: 'sent', email: id, sent: 6 });
    expect(out.sent.map((e) => e.to).sort()).toEqual(people.slice(4).map((p) => p.email).sort());
    expect(await statusOf(id)).toBe('sent');
    expect((await deliveries(id)).filter((d) => d.endsWith(':failed'))).toEqual([`${people[3]!.id}:failed`]);
  });

  test('five refusals in a row pause it for ten minutes, give those five back, and it finishes later', async () => {
    people = many(8);
    const id = await newEmail('Paused');
    await slotDue(sql, 2);
    out.failWhen = () => new Error('The domain is not verified');
    const paused = await app.sendDue();
    expect(paused.state).toBe('paused');
    expect(out.sent).toEqual([]);
    expect(await deliveries(id)).toEqual([]);
    const row = (await sql<{ last_error: string; retry_after: Date; status: string }[]>`select last_error, retry_after, status from marketing_emails where id = ${id}`)[0]!;
    expect(row.status).toBe('sending');
    expect(row.last_error).toContain('The domain is not verified');
    expect(row.retry_after.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await page()).sending?.lastError).toContain('The domain is not verified');

    // Still waiting: nothing happens, and no new email takes another slot meanwhile.
    expect((await app.sendDue()).state).toBe('paused');
    out.failWhen = null;
    await sql`update marketing_emails set retry_after = now() - interval '1 second' where id = ${id}`;
    const done = await app.sendDue();
    expect(done).toMatchObject({ state: 'sent', sent: 8 });
    expect(new Set(out.sent.map((e) => e.to)).size).toBe(8);
    expect((await sql<{ last_error: string | null }[]>`select last_error from marketing_emails where id = ${id}`)[0]!.last_error).toBeNull();
  });

  test('one person the service refuses is kept as failed, with the reason, and the rest still get it', async () => {
    const id = await newEmail('Mostly fine');
    await slotDue(sql, 2);
    out.failWhen = (email) => (email.to === 'creator@example.test' ? { message: 'Mailbox does not exist' } : null);
    expect(await app.sendDue()).toMatchObject({ state: 'sent', sent: 2, failed: 1 });
    expect((await sql<{ error: string }[]>`select error from marketing_deliveries where email_id = ${id} and status = 'failed'`)[0]?.error).toBe('Mailbox does not exist');
    expect((await page()).sent[0]).toMatchObject({ sent: 2, failed: 1 });
  });

  test('a send the app reports as failed in its answer counts as failed', async () => {
    app = createMarketingEmails({ ...fakeConfig({ db: () => sql, recipients: async () => people }), send: async () => ({ data: null, error: { message: 'Rate limit' } }) }, { sleep: async () => undefined });
    await newEmail('Refused');
    await slotDue(sql, 2);
    expect(await app.sendDue()).toMatchObject({ state: 'sent', sent: 0, failed: 3 });
  });

  test('stopping an email going out: nobody else gets it', async () => {
    people = many(60);
    let n = 0;
    let id = '';
    app = createMarketingEmails(
      {
        ...fakeConfig({ db: () => sql, out, recipients: async () => people }),
        send: async (email) => {
          n += 1;
          // Stopped from the page after the tenth email went.
          if (n === 10) await sql`update marketing_emails set status = 'stopped' where id = ${id}`;
          out.sent.push(email);
        },
      },
      { sleep: async () => undefined },
    );
    id = await newEmail('Stop me');
    await slotDue(sql, 2);
    const pass = await app.sendDue();
    expect(pass.state).toBe('stopped');
    expect(out.sent.length).toBeLessThanOrEqual(25);
    expect(await statusOf(id)).toBe('stopped');
    expect((await app.sendDue()).state).toBe('nothing_due');
  });

  test('the Stop button stops it and the page lists it with what it reached', async () => {
    const id = await newEmail('Going');
    await sql`update marketing_emails set status = 'sending', slot_at = now(), started_at = now() where id = ${id}`;
    expect((await post(`/api/marketing-emails/manage/emails/${id}/stop`, {})).status).toBe(204);
    expect(await statusOf(id)).toBe('stopped');
    expect((await page()).sent.map((e) => e.status)).toEqual(['stopped']);
  });

  test('the unsubscribe link: the page only asks, the button and the inbox button unsubscribe, and it can be undone', async () => {
    await newEmail('Hello');
    await slotDue(sql, 2);
    await app.sendDue();
    const link = (to: string) => /^<(.+)>$/.exec(out.sent.find((e) => e.to === to)!.headers['List-Unsubscribe']!)![1]!;
    const path = (url: string) => url.replace('https://app.example.com', '');

    // Opening the link (as mail scanners do) changes nothing.
    const opened = await app.routeHandlers.GET(request(path(link('agency@example.test')), { origin: null }));
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain('Stop marketing emails from Example App?');
    expect((await sql`select 1 from marketing_unsubscribes`).length).toBe(0);

    // The page's button.
    const form = await app.routeHandlers.POST(request(path(link('agency@example.test')), { origin: 'https://app.example.com', raw: 'action=unsubscribe', type: 'application/x-www-form-urlencoded' }));
    expect(await form.text()).toContain('You&#39;re unsubscribed');
    // Gmail's own button: a post from its servers, with no origin.
    const oneClick = await app.routeHandlers.POST(request(path(link('creator@example.test')), { origin: null, raw: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' }));
    expect(oneClick.status).toBe(200);
    const left = await sql<{ user_id: string; email_id: string | null }[]>`select user_id, email_id from marketing_unsubscribes order by user_id`;
    expect(left.map((r) => r.user_id)).toEqual(['usr_agency', 'usr_creator']);
    expect(left.every((r) => r.email_id)).toBe(true);
    expect((await page()).sent[0]?.unsubscribed).toBe(2);
    expect((await page()).audience).toEqual({ count: 1, unsubscribed: 2 });

    // Undo.
    await app.routeHandlers.POST(request(path(link('agency@example.test')), { raw: 'action=resubscribe', type: 'application/x-www-form-urlencoded' }));
    expect((await sql`select user_id from marketing_unsubscribes`).map((r) => r.user_id)).toEqual(['usr_creator']);

    // A made-up link and a test's link change nothing.
    expect(await (await app.routeHandlers.GET(request('/api/marketing-emails/unsubscribe?t=nope'))).text()).toContain('This link doesn&#39;t work anymore');
    expect(await (await app.routeHandlers.GET(request('/api/marketing-emails/unsubscribe?t=test'))).text()).toContain('This was a test email');
  });

  test('the app\'s own settings switch: off, on, and never from a view-as session', async () => {
    const me = async (who: string) => (await (await app.routeHandlers.GET(request('/api/marketing-emails/me/emails', { cookie: cookieFor(who) }))).json()) as MyEmailsAnswer;
    expect(await me('agency')).toEqual({ available: true, subscribed: true });
    expect((await post('/api/marketing-emails/me/emails', { subscribed: false }, 'agency')).status).toBe(200);
    expect(await me('agency')).toEqual({ available: true, subscribed: false });
    await newEmail('Not for you');
    await slotDue(sql, 2);
    await app.sendDue();
    expect(out.sent.map((e) => e.to)).not.toContain('agency@example.test');
    await post('/api/marketing-emails/me/emails', { subscribed: true }, 'agency');
    expect(await me('agency')).toEqual({ available: true, subscribed: true });
    expect((await post('/api/marketing-emails/me/emails', { subscribed: false }, 'staff')).status).toBe(403);
  });

  test('the line: move up and down, change, remove; a roundup is never removed by hand', async () => {
    const a = await newEmail('A');
    const b = await newEmail('B');
    await newPost('A post');
    const order = async () => (await page()).queue.map((e) => (e.kind === 'roundup' ? 'roundup' : e.subject));
    expect(await order()).toEqual(['A', 'B', 'roundup']);
    expect((await post(`/api/marketing-emails/manage/emails/${b}/move`, { direction: 'up' })).status).toBe(204);
    expect(await order()).toEqual(['B', 'A', 'roundup']);
    expect((await post(`/api/marketing-emails/manage/emails/${b}/move`, { direction: 'up' })).status).toBe(400);
    const roundup = (await page()).queue.find((e) => e.kind === 'roundup')!.id;
    expect((await post(`/api/marketing-emails/manage/emails/${roundup}/move`, { direction: 'up' })).status).toBe(204);
    expect(await order()).toEqual(['B', 'roundup', 'A']);
    expect((await app.routeHandlers.DELETE(request(`/api/marketing-emails/manage/emails/${roundup}`, { method: 'DELETE', cookie: cookieFor('admin') }))).status).toBe(404);
    expect((await app.routeHandlers.DELETE(request(`/api/marketing-emails/manage/emails/${a}`, { method: 'DELETE', cookie: cookieFor('admin') }))).status).toBe(204);
    expect(await order()).toEqual(['B', 'roundup']);
    expect((await post(`/api/marketing-emails/manage/emails/${roundup}`, { kind: 'roundup', subject: 'This month', headline: '', body: '', preheader: '' })).status).toBe(200);
    expect((await page()).queue.find((e) => e.kind === 'roundup')?.subject).toBe('This month');
    // The other kind can't be written over it.
    expect((await post(`/api/marketing-emails/manage/emails/${roundup}`, { kind: 'feature', subject: 'x', html: '<p>x</p>' })).status).toBe(400);
  });

  test('turning roundups off takes the waiting one out; turning them on brings it back', async () => {
    await newPost('A post');
    expect((await page()).queue).toHaveLength(1);
    expect((await post('/api/marketing-emails/manage/settings', { roundups: false })).status).toBe(200);
    expect((await page()).queue).toHaveLength(0);
    await post('/api/marketing-emails/manage/settings', { roundups: true });
    expect((await page()).queue.map((e) => e.kind)).toEqual(['roundup']);
  });

  test('the schedule: saved from the page, the line lined up on its slots', async () => {
    await newEmail('One');
    await newEmail('Two');
    const saved = await post('/api/marketing-emails/manage/settings', { cadence: 'every_2_weeks', weekday: 2, time: '10:00' });
    expect(saved.status).toBe(200);
    const answer = await page();
    expect(answer.scheduleText).toBe('Every other Tuesday at 10:00 AM');
    expect(answer.settings.firstSendOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [first, second] = answer.queue.map((e) => new Date(e.slotAt!).getTime());
    expect(second! - first!).toBe(14 * 86_400_000);
    expect(new Date(answer.queue[0]!.slotAt!).getUTCDay()).toBe(2);
    expect((await post('/api/marketing-emails/manage/settings', { time: '03:15' })).status).toBe(400);
    expect((await post('/api/marketing-emails/manage/settings', { cadence: 'daily' })).status).toBe(400);
  });

  test('sending will not turn on until the setup is complete, and the page says what is missing', async () => {
    app = make({ postalAddress: '' });
    const answer = await page();
    expect(answer.missing.join(' ')).toContain('postal address');
    const refused = await post('/api/marketing-emails/manage/settings', { sending: true });
    expect(refused.status).toBe(400);
    expect((await app.sendDue()).state).toBe('not_set_up');
  });

  test("an app without What's New: no roundup ever joins the line, written emails still go", async () => {
    app = make({ whatsNew: false });
    await newPost('Not for this app');
    const answer = await page();
    expect(answer.whatsNew).toBe(false);
    expect(answer.queue).toEqual([]);
    expect(answer.roundupPosts).toEqual([]);
    await newEmail('Written');
    await slotDue(sql, 2);
    expect(await app.sendDue()).toMatchObject({ state: 'sent', sent: 3 });
    expect(out.sent.every((e) => e.subject === 'Written')).toBe(true);
  });

  test("What's New set up but its table missing: the page still loads, with no roundup", async () => {
    await sql`drop table whats_new_posts`;
    try {
      const answer = await page();
      expect(answer.whatsNew).toBe(false);
      expect(answer.queue).toEqual([]);
    } finally {
      await migrate(sql);
    }
  });

  test('forgetAccount leaves nothing about the account behind', async () => {
    await newEmail('Hello');
    await slotDue(sql, 2);
    await app.sendDue();
    await sql`insert into marketing_unsubscribes (user_id) values ('usr_agency')`;
    expect(await app.forgetAccount('usr_agency')).toBe(true);
    expect((await sql`select 1 from marketing_deliveries where user_id = 'usr_agency'`).length).toBe(0);
    expect((await sql`select 1 from marketing_unsubscribes where user_id = 'usr_agency'`).length).toBe(0);
  });

  test('send me a test: only to the person asking, marked as a test, ten an hour', async () => {
    const send = (body: Record<string, unknown>) => post('/api/marketing-emails/manage/test', body);
    const response = await send({ kind: 'feature', subject: 'Try it', html: emailHtml('Try it') });
    expect(response.status).toBe(200);
    expect(out.sent.map((e) => [e.to, e.subject])).toEqual([['admin@example.com', '[Test] Try it']]);
    expect(out.sent[0]?.headers['List-Unsubscribe']).toBe('<https://app.example.com/api/marketing-emails/unsubscribe?t=test>');
    expect((await sql`select 1 from marketing_deliveries`).length).toBe(0);

    // A roundup test needs a post waiting.
    expect((await send({ kind: 'roundup', subject: '', headline: '', body: '', preheader: '' })).status).toBe(400);
    await newPost('Something new');
    expect((await send({ kind: 'roundup', subject: '', headline: '', body: '', preheader: '' })).status).toBe(200);
    expect(out.sent.at(-1)?.html).toContain('Something new');

    for (let i = 0; i < 8; i += 1) await send({ kind: 'feature', subject: 'Again', html: '<p>Again</p>' });
    expect((await send({ kind: 'feature', subject: 'Again', html: '<p>Again</p>' })).status).toBe(429);

    out.failWhen = () => new Error('Invalid API key');
    const failing = make();
    const failed = await failing.routeHandlers.POST(request('/api/marketing-emails/manage/test', { cookie: cookieFor('admin'), body: { kind: 'feature', subject: 'x', html: '<p>x</p>' } }));
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain('Invalid API key');
  });

  test('a sent email can be viewed as it went out', async () => {
    const id = await newEmail('Look back');
    await slotDue(sql, 2);
    await app.sendDue();
    const response = await app.routeHandlers.GET(request(`/api/marketing-emails/manage/emails/${id}/view`, { cookie: cookieFor('admin') }));
    const body = (await response.json()) as { subject: string; html: string };
    expect(body.subject).toBe('Look back');
    expect(body.html).toContain('https://app.example.com/x?utm_source=email');
  });

  test('the app cannot list who gets it: the email waits and tries again', async () => {
    app = make({ recipients: async () => null });
    const id = await newEmail('Waits');
    await slotDue(sql, 2);
    expect((await app.sendDue()).state).toBe('paused');
    expect(await statusOf(id)).toBe('sending');
    expect((await sql<{ last_error: string }[]>`select last_error from marketing_emails where id = ${id}`)[0]?.last_error).toContain('could not list');
  });
});
