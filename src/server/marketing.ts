// Marketing emails in the database: the schedule, the queue, what went out,
// and the reads and writes of the Admin page. The sender (./sender.ts) is
// what actually sends them.
//
// The queue's rules (the README has them in full):
// - Emails wait in a line. Each slot of the schedule takes the first one.
// - While roundups are on, a roundup joins the end of the line as soon as a
//   live post is waiting to be emailed, and gathers every post until it
//   goes. There is never more than one waiting.
// - Only waiting emails can be changed, moved or removed; a roundup is never
//   removed by hand (turn its posts' email off, or turn roundups off).
import { randomUUID } from 'node:crypto';
import type { ConfigCore, MarketingSql } from '../config';
import type { EmailInput, MarketingSettings, PostView, QueuedEmail, SentEmail, SettingsInput } from '../shared/api';
import { roundupSubject } from '../shared/email';
import { LIMITS } from '../shared/limits';
import { CADENCES, dueSlot, isoDate, localDate, SEND_TIMES, slotsAfter, type Cadence, type Schedule } from '../shared/schedule';
import { isFieldError, readAudience, readHtml, type FieldError } from './fields';
import { roundupPost, roundupPostRows, waitingPostRows } from './roundup';

type SettingsRow = {
  sending: boolean;
  cadence: Cadence;
  weekday: number;
  send_time: string;
  first_send_on: string | Date | null;
  roundups: boolean;
};

export type EmailRow = {
  id: string;
  kind: 'roundup' | 'feature';
  status: 'queued' | 'sending' | 'sent' | 'stopped';
  position: number;
  subject: string;
  preheader: string;
  headline: string;
  body: string;
  html: string;
  audience: string[];
  slot_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  retry_after: Date | null;
  last_error: string | null;
};

function dateText(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

export async function readSettings(sql: MarketingSql, config: Pick<ConfigCore, 'timeZone'>): Promise<MarketingSettings> {
  const rows = await sql<SettingsRow[]>`select sending, cadence, weekday, send_time, first_send_on::text as first_send_on, roundups from marketing_settings where id = 1`;
  const row = rows[0];
  return {
    sending: row?.sending ?? false,
    cadence: row?.cadence ?? 'every_2_weeks',
    weekday: row?.weekday ?? 2,
    time: row?.send_time ?? '10:00',
    firstSendOn: dateText(row?.first_send_on ?? null),
    roundups: row?.roundups ?? true,
    timeZone: config.timeZone,
  };
}

export function scheduleOf(settings: MarketingSettings): Schedule {
  return { cadence: settings.cadence, weekday: settings.weekday, time: settings.time, firstSendOn: settings.firstSendOn, timeZone: settings.timeZone };
}

/** The schedule change from the page, checked. */
export function readSettingsInput(body: Record<string, unknown>): SettingsInput | FieldError {
  const out: { sending?: boolean; cadence?: Cadence; weekday?: number; time?: string; roundups?: boolean } = {};
  if (body.sending !== undefined) {
    if (typeof body.sending !== 'boolean') return { error: 'Turn sending on or off.', field: 'sending' };
    out.sending = body.sending;
  }
  if (body.cadence !== undefined) {
    if (!CADENCES.includes(body.cadence as Cadence)) return { error: 'Pick how often from the list.', field: 'cadence' };
    out.cadence = body.cadence as Cadence;
  }
  if (body.weekday !== undefined) {
    if (typeof body.weekday !== 'number' || !Number.isInteger(body.weekday) || body.weekday < 0 || body.weekday > 6) return { error: 'Pick a day from the list.', field: 'weekday' };
    out.weekday = body.weekday;
  }
  if (body.time !== undefined) {
    if (typeof body.time !== 'string' || !SEND_TIMES.includes(body.time)) return { error: 'Pick a time from the list.', field: 'time' };
    out.time = body.time;
  }
  if (body.roundups !== undefined) {
    if (typeof body.roundups !== 'boolean') return { error: 'Turn roundups on or off.', field: 'roundups' };
    out.roundups = body.roundups;
  }
  return out;
}

/**
 * Saves the schedule. An every-2-weeks schedule counts from the next slot
 * its day and time give, so the first email goes out at the soonest time the
 * page shows. Turning roundups off takes a waiting roundup out of the line
 * (its posts stay unsent, ready for when roundups are back on).
 */
export async function saveSettings(sql: MarketingSql, config: Pick<ConfigCore, 'timeZone'>, input: SettingsInput, by: string, now = new Date()): Promise<MarketingSettings> {
  const current = await readSettings(sql, config);
  const next = { ...current, ...input };
  let firstSendOn = current.firstSendOn;
  const timingChanged = next.cadence !== current.cadence || next.weekday !== current.weekday || next.time !== current.time;
  if (next.cadence === 'every_2_weeks' && (timingChanged || !firstSendOn)) {
    const first = slotsAfter({ ...scheduleOf(next), cadence: 'weekly' }, now, 1)[0];
    firstSendOn = first ? isoDate(localDate(first, config.timeZone)) : null;
  }
  await sql`
    insert into marketing_settings (id, sending, cadence, weekday, send_time, first_send_on, roundups, updated_by, updated_at)
    values (1, ${next.sending}, ${next.cadence}, ${next.weekday}, ${next.time}, ${firstSendOn}, ${next.roundups}, ${by}, now())
    on conflict (id) do update set
      sending = excluded.sending, cadence = excluded.cadence, weekday = excluded.weekday, send_time = excluded.send_time,
      first_send_on = excluded.first_send_on, roundups = excluded.roundups, updated_by = excluded.updated_by, updated_at = now()
  `;
  if (input.roundups === false) await sql`delete from marketing_emails where kind = 'roundup' and status = 'queued'`;
  return { ...next, firstSendOn };
}

/** Live What's New posts waiting for the next roundup, newest first. */
export async function waitingPosts(sql: MarketingSql, config: ConfigCore, fullImages = false): Promise<PostView[]> {
  return (await waitingPostRows(sql, config)).map((row) => roundupPost(config, row, fullImages));
}

/**
 * Keeps the roundup in line with What's New: one waits at the end of the
 * line while roundups are on, the app has What's New, and a live post is
 * waiting; none waits otherwise. Safe to call from every server at once.
 */
export async function syncRoundup(sql: MarketingSql, config: ConfigCore, settings: MarketingSettings): Promise<void> {
  const waiting = settings.roundups && config.whatsNew ? (await waitingPostRows(sql, config)).length : 0;
  if (!waiting) {
    await sql`delete from marketing_emails where kind = 'roundup' and status = 'queued'`;
    return;
  }
  await sql`
    insert into marketing_emails (id, kind, status, position)
    select ${randomUUID()}, 'roundup', 'queued', coalesce(max(position), 0) + 1 from marketing_emails where status = 'queued'
    on conflict do nothing
  `;
}

export function emailView(config: ConfigCore, row: EmailRow, posts: readonly PostView[], progress: QueuedEmail['progress'] = null): QueuedEmail {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    preheader: row.preheader,
    headline: row.headline,
    body: row.body,
    html: row.html,
    audience: row.audience,
    slotAt: row.slot_at?.toISOString() ?? null,
    posts,
    progress,
    lastError: row.last_error,
    retryAfter: row.retry_after?.toISOString() ?? null,
  };
}

/**
 * The line of waiting emails, each with the slot it is lined up for. When a
 * slot is due right now and nothing took it yet, the first email goes in it.
 */
export async function queueView(sql: MarketingSql, config: ConfigCore, settings: MarketingSettings, now = new Date()) {
  const rows = await sql<EmailRow[]>`select * from marketing_emails where status = 'queued' order by position, created_at`;
  const schedule = scheduleOf(settings);
  const due = dueSlot(schedule, now);
  let slots: Date[] = [];
  if (due) {
    const taken = await sql`select 1 from marketing_emails where slot_at = ${due}`;
    if (!taken.length) slots.push(due);
  }
  slots = [...slots, ...slotsAfter(schedule, now, Math.max(rows.length, 4) + 1)];
  const waiting = rows.some((row) => row.kind === 'roundup') ? await waitingPosts(sql, config) : [];
  return {
    queue: rows.map((row, i) => ({ ...emailView(config, row, row.kind === 'roundup' ? waiting : []), slotAt: slots[i]?.toISOString() ?? null })),
    nextSlots: slots.slice(0, 4).map((slot) => slot.toISOString()),
    roundupPosts: waiting,
  };
}

/** The email going out now, with how far it got. */
export async function sendingView(sql: MarketingSql, config: ConfigCore): Promise<QueuedEmail | null> {
  const rows = await sql<EmailRow[]>`select * from marketing_emails where status = 'sending' order by slot_at limit 1`;
  const row = rows[0];
  if (!row) return null;
  const counts = await sql<{ sent: number; failed: number }[]>`
    select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed
    from marketing_deliveries where email_id = ${row.id}
  `;
  const posts = row.kind === 'roundup' ? await postsOf(sql, config, row.id) : [];
  return emailView(config, row, posts, { sent: counts[0]?.sent ?? 0, failed: counts[0]?.failed ?? 0 });
}

/** The posts a roundup carried (or carries, once it started), newest first. */
export async function postsOf(sql: MarketingSql, config: ConfigCore, emailId: string, fullImages = false): Promise<PostView[]> {
  return (await roundupPostRows(sql, emailId)).map((row) => roundupPost(config, row, fullImages));
}

/**
 * The latest emails that went out, newest first, with how many each reached.
 * A roundup sent without a written subject shows the one people got.
 */
export async function sentView(sql: MarketingSql, config: Pick<ConfigCore, 'brand'>): Promise<SentEmail[]> {
  const rows = await sql<
    (Pick<EmailRow, 'id' | 'kind' | 'subject' | 'slot_at' | 'finished_at'> & {
      status: 'sent' | 'stopped';
      sent: number;
      failed: number;
      unsubscribed: number;
      post_count: number;
    })[]
  >`
    select e.id, e.kind, e.status, e.subject, e.slot_at, e.finished_at,
      (select count(*) from marketing_deliveries d where d.email_id = e.id and d.status = 'sent')::int as sent,
      (select count(*) from marketing_deliveries d where d.email_id = e.id and d.status = 'failed')::int as failed,
      (select count(*) from marketing_unsubscribes u where u.email_id = e.id)::int as unsubscribed,
      (select count(*) from marketing_roundup_posts r where r.email_id = e.id)::int as post_count
    from marketing_emails e
    where e.status in ('sent', 'stopped')
    order by e.slot_at desc
    limit 50
  `;
  return Promise.all(
    rows.map(async (row) => {
      let subject = row.subject;
      // A roundup sent without a written subject shows the one people got.
      if (!subject && row.kind === 'roundup') {
        const first = row.post_count === 1 ? (await roundupPostRows(sql, row.id))[0] : undefined;
        subject = roundupSubject(config.brand, first ? [first] : Array.from({ length: Math.max(2, row.post_count) }, () => ({ title: '' })));
      }
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        subject,
        slotAt: row.slot_at?.toISOString() ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
        sent: row.sent,
        failed: row.failed,
        unsubscribed: row.unsubscribed,
      };
    }),
  );
}

export async function unsubscribedCount(sql: MarketingSql): Promise<number> {
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from marketing_unsubscribes`;
  return rows[0]?.n ?? 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

/** An email from the editor, checked. A roundup takes only its words; its posts come from What's New. */
export function readEmailInput(body: Record<string, unknown>, config: Pick<ConfigCore, 'audiences'>): EmailInput | FieldError {
  const kind = body.kind;
  if (kind !== 'feature' && kind !== 'roundup') return { error: 'Pick what kind of email it is.', field: 'kind' };
  const subject = text(body.subject).replace(/\s+/g, ' ');
  const preheader = text(body.preheader).replace(/\s+/g, ' ');
  if (subject.length > LIMITS.subject) return { error: `Keep the subject to ${LIMITS.subject} characters.`, field: 'subject' };
  if (preheader.length > LIMITS.preheader) return { error: `Keep the preview text to ${LIMITS.preheader} characters.`, field: 'preheader' };
  if (kind === 'roundup') {
    const headline = text(body.headline).replace(/\s+/g, ' ');
    const intro = text(body.body);
    if (headline.length > LIMITS.headline) return { error: `Keep the headline to ${LIMITS.headline} characters.`, field: 'headline' };
    if (intro.length > LIMITS.intro) return { error: `Keep the line at the top to ${LIMITS.intro} characters.`, field: 'body' };
    return { kind, subject, preheader, headline, body: intro };
  }
  if (!subject) return { error: 'Give the email a subject.', field: 'subject' };
  const html = readHtml(body.html);
  if (isFieldError(html)) return html;
  const audience = readAudience(body, config);
  if (isFieldError(audience)) return audience;
  return { kind, subject, preheader, html, audience };
}

/** Puts a written email at the end of the line. Answers its id. */
export async function createEmail(sql: MarketingSql, input: Extract<EmailInput, { kind: 'feature' }>, by: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into marketing_emails (id, kind, status, position, subject, preheader, html, audience, created_by, updated_by)
    select ${id}, 'feature', 'queued', coalesce(max(position), 0) + 1, ${input.subject}, ${input.preheader}, ${input.html},
           ${input.audience as string[]}::text[], ${by}, ${by}
    from marketing_emails where status = 'queued'
  `;
  return id;
}

/** Changes a waiting email. 'kind' when the input is the other kind, null when there is no such waiting email. */
export async function updateEmail(sql: MarketingSql, id: string, input: EmailInput, by: string): Promise<'ok' | 'kind' | null> {
  const rows = await sql<{ kind: string }[]>`select kind from marketing_emails where id = ${id} and status = 'queued'`;
  const row = rows[0];
  if (!row) return null;
  if (row.kind !== input.kind) return 'kind';
  if (input.kind === 'roundup') {
    await sql`
      update marketing_emails set subject = ${input.subject}, preheader = ${input.preheader}, headline = ${input.headline}, body = ${input.body},
        updated_by = ${by}, updated_at = now()
      where id = ${id} and status = 'queued'
    `;
  } else {
    await sql`
      update marketing_emails set subject = ${input.subject}, preheader = ${input.preheader}, html = ${input.html}, audience = ${input.audience as string[]}::text[],
        updated_by = ${by}, updated_at = now()
      where id = ${id} and status = 'queued'
    `;
  }
  return 'ok';
}

/** Takes a waiting written email out of the line. False when there is no such email (a roundup is never removed by hand). */
export async function deleteEmail(sql: MarketingSql, id: string): Promise<boolean> {
  const rows = await sql`delete from marketing_emails where id = ${id} and status = 'queued' and kind = 'feature' returning id`;
  return rows.length > 0;
}

/** Swaps a waiting email with the one before or after it. False when it cannot move that way. */
export async function moveEmail(sql: MarketingSql, id: string, direction: 'up' | 'down'): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; position: number }[]>`select id, position from marketing_emails where status = 'queued' order by position, created_at for update`;
    const at = rows.findIndex((row) => row.id === id);
    const other = direction === 'up' ? at - 1 : at + 1;
    if (at < 0 || other < 0 || other >= rows.length) return false;
    // Positions are renumbered in order, so equal positions can never block a move.
    const order = rows.map((row) => row.id);
    [order[at], order[other]] = [order[other]!, order[at]!];
    for (const [i, rowId] of order.entries()) {
      await tx`update marketing_emails set position = ${i + 1} where id = ${rowId}`;
    }
    return true;
  });
}

/** Stops an email that is going out: nobody it has not reached yet gets it. False when none is going out with that id. */
export async function stopEmail(sql: MarketingSql, id: string, by: string): Promise<boolean> {
  const rows = await sql`
    update marketing_emails set status = 'stopped', finished_at = now(), updated_by = ${by}, updated_at = now()
    where id = ${id} and status = 'sending' returning id
  `;
  return rows.length > 0;
}

/** A sent email as it went out, for "View" on the Sent tab. */
export async function sentEmail(sql: MarketingSql, id: string): Promise<EmailRow | null> {
  const rows = await sql<EmailRow[]>`select * from marketing_emails where id = ${id} and status in ('sending', 'sent', 'stopped')`;
  return rows[0] ?? null;
}

export async function isUnsubscribed(sql: MarketingSql, userId: string): Promise<boolean> {
  const rows = await sql`select 1 from marketing_unsubscribes where user_id = ${userId}`;
  return rows.length > 0;
}

/** Records a no (from an email's link, with the email it came from, or from the app's settings). */
export async function unsubscribe(sql: MarketingSql, userId: string, emailId: string | null): Promise<void> {
  await sql`
    insert into marketing_unsubscribes (user_id, email_id) values (${userId}, ${emailId})
    on conflict (user_id) do nothing
  `;
}

export async function resubscribe(sql: MarketingSql, userId: string): Promise<void> {
  await sql`delete from marketing_unsubscribes where user_id = ${userId}`;
}

/** The accounts among these that said no, read in batches of 500. */
export async function unsubscribedAmong(sql: MarketingSql, userIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id !== ''))];
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await sql<{ user_id: string }[]>`select user_id from marketing_unsubscribes where user_id in ${sql(ids.slice(i, i + 500))}`;
    for (const row of rows) found.add(row.user_id);
  }
  return found;
}
