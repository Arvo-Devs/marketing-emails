// A pretend app for the tests: its sign-in reads a `session=<who>` cookie,
// anyone on MASS_ACCESS may manage the page, it has two groups of people
// (agencies and creators), its email sender is an outbox the test reads
// (which can be told to fail), and it has What's New in the same database.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { MarketingEmailsConfig, MarketingRecipient, MarketingUser, OutgoingEmail } from '../src/config';

export type Person = MarketingUser & { id: string; email: string };

export const SITE = 'https://app.example.com';

export const PEOPLE: Record<string, Person> = {
  admin: { id: 'usr_admin', email: 'admin@example.com' },
  agency: { id: 'usr_agency', email: 'agency@example.test' },
  creator: { id: 'usr_creator', email: 'creator@example.test' },
  staff: { id: 'usr_staff', email: 'staff@example.com', viewedAs: true },
};

export const MASS_ACCESS = new Set(['usr_admin']);

export const cookieFor = (who: string) => `theme=dark; session=${who}`;

export type Outbox = {
  sent: OutgoingEmail[];
  /** Fail when it answers something, with what it gives. */
  failWhen: ((email: OutgoingEmail) => unknown) | null;
};

export function outbox(): Outbox {
  return { sent: [], failWhen: null };
}

export function request(path: string, init: { method?: string; cookie?: string; body?: unknown; origin?: string | null; raw?: BodyInit; type?: string } = {}): Request {
  const headers = new Headers();
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.origin !== null) headers.set('origin', init.origin ?? SITE);
  let body: BodyInit | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
    if (init.type) headers.set('content-type', init.type);
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set('content-type', 'application/json');
  }
  return new Request(`${SITE}${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
}

function who(request: Request): string | null {
  const match = /(?:^|;\s*)session=([a-z]+)/.exec(request.headers.get('cookie') ?? '');
  return match?.[1] ?? null;
}

export function fakeConfig(options: {
  db: () => postgres.Sql | null;
  out?: Outbox;
  recipients?: () => Promise<readonly MarketingRecipient[] | null>;
  postalAddress?: string;
  whatsNew?: boolean;
  sendOutsideProduction?: boolean;
  log?: (line: string) => void;
  /** Each send takes this long, so two servers can be caught sending at once. */
  sendMs?: number;
}): MarketingEmailsConfig<Person> {
  const out = options.out ?? outbox();
  return {
    db: options.db,
    signedInUser: async (request) => {
      const name = who(request);
      return name && PEOPLE[name] ? PEOPLE[name] : null;
    },
    canManage: (user) => MASS_ACCESS.has(user.id),
    siteUrl: SITE,
    brand: { name: 'Example App', color: '#4f46e5' },
    from: 'Example App <updates@app.example.com>',
    replyTo: 'support@app.example.com',
    postalAddress: options.postalAddress ?? '1 Example Way, Testville',
    recipients:
      options.recipients ??
      (async () => [
        { id: 'usr_agency', email: 'agency@example.test', audiences: ['agency'] },
        { id: 'usr_creator', email: 'creator@example.test', audiences: ['creator'] },
      ]),
    send: async (email) => {
      if (options.sendMs) await new Promise((resolve) => setTimeout(resolve, options.sendMs));
      const failure = out.failWhen?.(email);
      if (failure) throw failure;
      out.sent.push(email);
      return { id: `msg_${out.sent.length}` };
    },
    perSecond: 1000,
    sendOutsideProduction: options.sendOutsideProduction ?? true,
    audiences: [
      { key: 'agency', label: 'Agencies' },
      { key: 'creator', label: 'Creators' },
    ],
    timeZone: 'UTC',
    whatsNew: options.whatsNew === false ? null : { pageUrl: '/dashboard/whats-new' },
    log: options.log ?? (() => undefined),
  };
}

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');

/** This package's tables, and What's New's posts table (the roundup reads it). */
export async function migrate(sql: postgres.Sql, withWhatsNew = true) {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'));
  if (withWhatsNew) await sql.unsafe(readFileSync(join(import.meta.dir, 'whats-new-tables.sql'), 'utf8'));
}

/** A What's New post, as @arvo/whats-new would keep it: live now unless told otherwise. */
export async function addPost(
  sql: postgres.Sql,
  title: string,
  extra: Partial<{ summary: string; audience: string[]; inEmail: boolean; coverImageId: string | null; status: string; publishedAt: Date }> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    insert into whats_new_posts (id, title, summary, html, cover_image_id, audience, status, published_at, in_email)
    values (${id}, ${title}, ${extra.summary ?? `About ${title}.`}, ${`<h1>${title}</h1>`}, ${extra.coverImageId ?? null},
            ${extra.audience ?? []}::text[], ${extra.status ?? 'published'}, ${extra.publishedAt ?? new Date()}, ${extra.inEmail ?? true})
  `;
  return id;
}

/**
 * Puts a slot of the schedule `minutesAgo` minutes in the past (UTC, every
 * week), with sending on, so the next pass finds it due. Each call with a new
 * number is a new slot.
 */
export async function slotDue(sql: postgres.Sql, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const time = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  await sql`
    insert into marketing_settings (id, sending, cadence, weekday, send_time, roundups)
    values (1, true, 'weekly', ${at.getUTCDay()}, ${time}, true)
    on conflict (id) do update set sending = true, cadence = 'weekly', weekday = excluded.weekday, send_time = excluded.send_time
  `;
}
