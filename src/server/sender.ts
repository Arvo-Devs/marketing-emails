// The part that sends marketing emails. Every minute (startSending), or
// whenever the app's own scheduler calls sendDue, it:
//
// 1. Does nothing unless sending is switched on and the setup is complete.
// 2. Keeps the roundup in line with What's New.
// 3. Carries on with an email that is part way out, or, when a slot of the
//    schedule is due (up to LATE_WINDOW_MS after its time), takes the first
//    email in line for that slot. A slot takes one email, ever, even with
//    several servers ticking at once (a unique index on the slot).
// 4. Sends it to everyone the app lists who has not unsubscribed, once each:
//    the delivery row is written before the email goes, so a crash or a
//    second server can never send anyone the same email twice. A row left
//    unconfirmed for 15 minutes is marked failed, never sent again.
// 5. Five failures in a row means the email service is refusing everything
//    (a bad key, a domain not verified): those five are given back, the page
//    says why, and it tries again in 10 minutes. Nobody is skipped for it.
import { randomBytes } from 'node:crypto';
import type { ConfigCore, MarketingSql, OutgoingEmail } from '../config';
import { emailBrand, isFor } from '../config';
import type { EmailInput, PostView } from '../shared/api';
import { campaignName, renderEmail, type EmailContent } from '../shared/email';
import { TESTS_PER_HOUR } from '../shared/limits';
import { dueSlot } from '../shared/schedule';
import { oneLine } from './http';
import { readSettings, scheduleOf, syncRoundup, waitingPosts, type EmailRow } from './marketing';
import { roundupPost, roundupPostRows, waitingPostRows } from './roundup';

export type SendDueResult = Readonly<{
  /** What happened on this pass, for logs and tests. */
  state: 'not_set_up' | 'not_production' | 'off' | 'busy' | 'nothing_due' | 'sent' | 'partial' | 'stopped' | 'paused' | 'error';
  email: string | null;
  sent: number;
  failed: number;
}>;

const STALE_MINUTES = 15;
/** How long one pass sends for before it stops and leaves the rest to the next pass, so a pass fits a one-minute worker job. */
export const PASS_BUDGET_MS = 50_000;
const RETRY_MINUTES = 10;
const FAILURES_IN_A_ROW = 5;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Sleeper = (ms: number) => Promise<void>;

const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The headers that give the person's inbox its own Unsubscribe button (RFC 8058, which Gmail and Yahoo ask bulk senders for). */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** True when what the app's send gave back says it failed: a thrown error is handled where it is caught. */
function failedResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'error' in result) return (result as { error: unknown }).error || null;
  return null;
}

export function createSender(config: ConfigCore, sleep: Sleeper = realSleep) {
  let running = false;
  let saidNotProduction = false;
  const tests = new Map<string, number[]>();

  function unsubscribeUrl(token: string): string {
    return `${config.siteUrl}${config.basePath}/unsubscribe?t=${encodeURIComponent(token)}`;
  }

  /** Sets aside a delivery that never came back (a crash mid-send): failed, never sent again. */
  async function failStale(sql: MarketingSql) {
    await sql`
      update marketing_deliveries set status = 'failed', error = 'Not confirmed: the server stopped while sending this one.', updated_at = now()
      where status = 'sending' and updated_at < now() - make_interval(mins => ${STALE_MINUTES})
    `;
  }

  async function claim(sql: MarketingSql, slot: Date): Promise<EmailRow | null> {
    try {
      return await sql.begin(async (tx) => {
        for (;;) {
          const rows = await tx<EmailRow[]>`select * from marketing_emails where status = 'queued' order by position, created_at limit 1 for update skip locked`;
          const row = rows[0];
          if (!row) return null;
          if (row.kind === 'roundup') {
            const posts = await waitingPostRows(tx as unknown as MarketingSql, config, true);
            // Its posts went back to draft since it joined the line: nothing to send, so the next email takes the slot.
            if (!posts.length) {
              await tx`delete from marketing_emails where id = ${row.id}`;
              continue;
            }
            // The posts it carries, frozen now: posts published from here on wait for the next roundup.
            for (const post of posts) await tx`insert into marketing_roundup_posts (email_id, post_id) values (${row.id}, ${post.id})`;
          }
          const claimed = await tx<EmailRow[]>`
            update marketing_emails set status = 'sending', slot_at = ${slot}, started_at = now(), updated_at = now()
            where id = ${row.id} returning *
          `;
          return claimed[0] ?? null;
        }
      });
    } catch (error) {
      // Another server took this slot first.
      if ((error as { code?: string }).code === '23505') return null;
      throw error;
    }
  }

  async function pause(sql: MarketingSql, email: EmailRow, reason: string) {
    await sql`
      update marketing_emails set retry_after = now() + make_interval(mins => ${RETRY_MINUTES}), last_error = ${reason}, updated_at = now()
      where id = ${email.id}
    `;
  }

  async function deliver(sql: MarketingSql, email: EmailRow, budgetMs: number): Promise<SendDueResult> {
    const startedAt = Date.now();
    let recipients: Awaited<ReturnType<typeof config.recipients>>;
    try {
      recipients = await config.recipients();
    } catch (error) {
      config.log('[Marketing emails] the app could not list who gets the email', error);
      recipients = null;
    }
    if (!Array.isArray(recipients)) {
      await pause(sql, email, 'The app could not list who gets this email. It tries again in 10 minutes.');
      return { state: 'paused', email: email.id, sent: 0, failed: 0 };
    }

    const posts = email.kind === 'roundup' ? await roundupPostRows(sql, email.id) : [];
    const unsubscribed = new Set((await sql<{ user_id: string }[]>`select user_id from marketing_unsubscribes`).map((row) => row.user_id));
    const reached = new Set((await sql<{ user_id: string }[]>`select user_id from marketing_deliveries where email_id = ${email.id}`).map((row) => row.user_id));
    const brand = emailBrand(config);
    const campaign = campaignName(email, email.slot_at ?? new Date());
    const gap = Math.ceil(1000 / config.perSecond);
    const addresses = new Set<string>();
    let sent = 0;
    let failed = 0;
    let streak: string[] = [];
    let cleared = email.last_error === null;

    for (const [i, person] of recipients.entries()) {
      if (!person || typeof person.id !== 'string' || !person.id) continue;
      const to = typeof person.email === 'string' ? person.email.trim() : '';
      if (!EMAIL.test(to) || to.length > 320) continue;
      // The same address under two accounts gets it once.
      const key = to.toLowerCase();
      if (addresses.has(key)) continue;
      addresses.add(key);
      if (unsubscribed.has(person.id) || reached.has(person.id)) continue;

      let content: EmailContent;
      if (email.kind === 'roundup') {
        const theirs = posts.filter((post) => isFor(post.audience, person.audiences)).map((post) => roundupPost(config, post, true));
        if (!theirs.length) continue;
        content = { kind: 'roundup', subject: email.subject, preheader: email.preheader, headline: email.headline, body: email.body, posts: theirs };
      } else {
        if (!isFor(email.audience, person.audiences)) continue;
        content = { kind: 'feature', subject: email.subject, preheader: email.preheader, html: email.html };
      }

      // Stopped from the page since this pass began: nobody else gets it.
      if (i > 0 && i % 25 === 0) {
        const now = await sql<{ status: string }[]>`select status from marketing_emails where id = ${email.id}`;
        if (now[0]?.status !== 'sending') return { state: 'stopped', email: email.id, sent, failed };
      }

      const token = randomBytes(24).toString('base64url');
      const mine = await sql`
        insert into marketing_deliveries (email_id, user_id, token) values (${email.id}, ${person.id}, ${token})
        on conflict do nothing returning user_id
      `;
      // Another server is sending this one.
      if (!mine.length) continue;

      const url = unsubscribeUrl(token);
      const rendered = renderEmail(content, brand, { unsubscribeUrl: url, campaign });
      const outgoing: OutgoingEmail = {
        to,
        from: config.from,
        replyTo: config.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: unsubscribeHeaders(url),
      };
      try {
        const result = await config.send(outgoing);
        const refused = failedResult(result);
        if (refused) throw refused;
        await sql`update marketing_deliveries set status = 'sent', updated_at = now() where email_id = ${email.id} and user_id = ${person.id}`;
        sent += 1;
        streak = [];
        if (!cleared) {
          await sql`update marketing_emails set retry_after = null, last_error = null where id = ${email.id}`;
          cleared = true;
        }
      } catch (error) {
        const reason = oneLine(error);
        await sql`
          update marketing_deliveries set status = 'failed', error = ${reason}, updated_at = now()
          where email_id = ${email.id} and user_id = ${person.id}
        `;
        failed += 1;
        streak.push(person.id);
        if (streak.length >= FAILURES_IN_A_ROW) {
          await sql`delete from marketing_deliveries where email_id = ${email.id} and user_id = any(${streak}::text[])`;
          await pause(sql, email, `The email service refused the last ${FAILURES_IN_A_ROW} in a row: ${reason}`);
          config.log(`[Marketing emails] paused for ${RETRY_MINUTES} minutes: ${FAILURES_IN_A_ROW} failures in a row (${reason})`);
          return { state: 'paused', email: email.id, sent, failed: failed - FAILURES_IN_A_ROW };
        }
      }
      await sleep(gap);
      // Out of time for this pass: the next one carries on with whoever is left.
      if (Date.now() - startedAt > budgetMs) return { state: 'partial', email: email.id, sent, failed };
    }

    const open = await sql<{ n: number }[]>`select count(*)::int as n from marketing_deliveries where email_id = ${email.id} and status = 'sending'`;
    if ((open[0]?.n ?? 0) === 0) {
      await sql`
        update marketing_emails set status = 'sent', finished_at = now(), retry_after = null, last_error = null, updated_at = now()
        where id = ${email.id} and status = 'sending'
      `;
    }
    return { state: 'sent', email: email.id, sent, failed };
  }

  /**
   * One pass: sends whatever is due now, for at most budgetMs (default
   * PASS_BUDGET_MS); an email part way out carries on in the next pass.
   * Never throws.
   */
  async function sendDue(options: Readonly<{ budgetMs?: number; now?: () => Date }> = {}): Promise<SendDueResult> {
    const now = options.now ?? (() => new Date());
    const budgetMs = Math.max(0, options.budgetMs ?? PASS_BUDGET_MS);
    const none = { email: null, sent: 0, failed: 0 };
    if (config.missing.length) return { state: 'not_set_up', ...none };
    if (process.env.NODE_ENV !== 'production' && !config.sendOutsideProduction) {
      if (!saidNotProduction) {
        saidNotProduction = true;
        config.log('[Marketing emails] nothing is sent from this server: it is not running in production (NODE_ENV). A test setup with a test inbox sets sendOutsideProduction.');
      }
      return { state: 'not_production', ...none };
    }
    if (running) return { state: 'busy', ...none };
    running = true;
    try {
      const sql = await config.db();
      if (!sql) return { state: 'not_set_up', ...none };
      const settings = await readSettings(sql, config);
      if (!settings.sending) return { state: 'off', ...none };
      await syncRoundup(sql, config, settings);
      await failStale(sql);
      const going = await sql<EmailRow[]>`
        select * from marketing_emails
        where status = 'sending' and (retry_after is null or retry_after <= now())
        order by slot_at limit 1
      `;
      let email: EmailRow | null = going[0] ?? null;
      if (!email) {
        const waiting = await sql`select 1 from marketing_emails where status = 'sending' limit 1`;
        // One email at a time: a paused one keeps its turn.
        if (waiting.length) return { state: 'paused', ...none };
        const slot = dueSlot(scheduleOf(settings), now());
        if (!slot) return { state: 'nothing_due', ...none };
        const taken = await sql`select 1 from marketing_emails where slot_at = ${slot}`;
        if (taken.length) return { state: 'nothing_due', ...none };
        email = await claim(sql, slot);
        if (!email) return { state: 'nothing_due', ...none };
      }
      return await deliver(sql, email, budgetMs);
    } catch (error) {
      config.log('[Marketing emails] a send pass failed', error);
      return { state: 'error', ...none };
    } finally {
      running = false;
    }
  }

  /**
   * For an app with no worker yet: a pass every minute inside this server,
   * until the returned function stops it. The standard is the app's pg-boss
   * worker calling sendDue() every minute (README, "Sending on its own").
   * Like sendDue, it sends nothing outside production.
   */
  function startSending(options: Readonly<{ everyMs?: number }> = {}): () => void {
    const pass = () => {
      void sendDue();
    };
    const first = setTimeout(pass, 15_000);
    const timer = setInterval(pass, Math.max(10_000, options.everyMs ?? 60_000));
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  /** True when this person may send another test this hour (and counts this one). */
  function mayTest(userId: string): boolean {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recent = (tests.get(userId) ?? []).filter((at) => at > hourAgo);
    if (recent.length >= TESTS_PER_HOUR) return false;
    recent.push(Date.now());
    tests.set(userId, recent);
    return true;
  }

  /**
   * Sends one email as it would go out, to `to` only, marked as a test. A
   * roundup carries the posts waiting for the next one. Throws with a line
   * the page can show when it cannot go.
   */
  async function sendTest(sql: MarketingSql, input: EmailInput, to: string): Promise<void> {
    let content: EmailContent;
    if (input.kind === 'roundup') {
      const posts = await waitingPosts(sql, config, true);
      if (!posts.length) throw new Error("No posts are waiting for a roundup yet. Publish a post on What's New first.");
      content = { ...input, posts };
    } else {
      content = { kind: 'feature', subject: input.subject, preheader: input.preheader, html: input.html };
    }
    const url = unsubscribeUrl('test');
    const rendered = renderEmail(content, emailBrand(config), { unsubscribeUrl: url, campaign: campaignName(content, new Date()), test: true });
    const result = await config.send({
      to,
      from: config.from,
      replyTo: config.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: unsubscribeHeaders(url),
    });
    const refused = failedResult(result);
    if (refused) throw refused instanceof Error ? refused : new Error(oneLine(refused));
  }

  return { sendDue, startSending, sendTest, mayTest };
}

export type Sender = ReturnType<typeof createSender>;
