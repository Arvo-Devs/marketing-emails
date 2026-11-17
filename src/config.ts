// The contract between the package and the app that installs it. Everything
// that differs from app to app comes in through here: the database, who is
// signed in and who may manage the page, the site's address and brand, who
// may get marketing emails and how the app sends email, and, for the
// roundup, where the app's What's New is.
//
// normalizeConfig reads it once, in createMarketingEmails. It imports
// nothing that needs Node, so a page that imports a type from here stays a
// browser bundle.
import type postgres from 'postgres';
import type { Audience, EmailBrand } from './shared/api';
import { brandColor } from './shared/email';
import { isTimeZone } from './shared/schedule';

/**
 * A postgres.js client for the app's database, with the package's tables
 * (migrations/). Give it one nothing wraps with drizzle: drizzle(sql) changes
 * how a shared client reads dates and JSON.
 */
export type MarketingSql = postgres.Sql;

/** The person signed in, as the app's auth knows them on this request. */
export type MarketingUser = Readonly<{
  id: string;
  /** Where "Send me a test" goes, for the people who manage the page. */
  email?: string | null;
  /** True in a staff member's view-as session: the person's own email choice can't be changed from it. */
  viewedAs?: boolean;
}>;

/** One person who may get marketing emails, as the app knows them now. */
export type MarketingRecipient = Readonly<{
  id: string;
  email: string;
  /** The app's groups this person is in (keys from `audiences`). */
  audiences?: readonly string[] | null;
}>;

/** One email for the app to send, through whatever it already sends email with. */
export type OutgoingEmail = Readonly<{
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  /** List-Unsubscribe and List-Unsubscribe-Post, so Gmail and Yahoo show their own Unsubscribe button. Send them as they are. */
  headers: Readonly<Record<string, string>>;
}>;

export type MarketingLog = (line: string, error?: unknown) => void;

export type MarketingEmailsConfig<User extends MarketingUser = MarketingUser> = Readonly<{
  /** The database, or null when it is not set up (the routes answer 503). A function, so nothing connects at build time. */
  db: () => Promise<MarketingSql | null> | MarketingSql | null;
  /** Who is signed in, asked on every call that needs it. */
  signedInUser: (request: Request) => Promise<User | null>;
  /** True for the people who may manage Admin › Marketing emails: the app's Mass Access check, or the Team import's check for that page. */
  canManage: (user: User) => boolean | Promise<boolean>;
  /** The site's public address, like https://yourapp.com: emails link here, and pictures and unsubscribe pages are served from it. */
  siteUrl: string;
  /** The hosts the site's own pages are on, for the check that a change came from them. Default: siteUrl's host. */
  siteHosts?: readonly string[];
  brand: Readonly<{
    /** "Your app", as it should read in an email. */
    name: string;
    /** A full https address of the logo for the top of a roundup (about 28 px tall). Default: the name in bold. */
    logoUrl?: string | null;
    /** The roundup's button color, like #4f46e5. Default near-black. */
    color?: string | null;
  }>;
  /** "Your app <updates@yourapp.com>": an address on a domain the app's email service has verified. */
  from: string;
  /** Where replies go, like the support address. Default: none. */
  replyTo?: string | null;
  /** The company's postal address, printed at the bottom of every email (CAN-SPAM). Nothing goes out without it. */
  postalAddress: string;
  /**
   * Everyone who may get marketing emails right now: active accounts with a
   * confirmed email that did not say no in the app's own settings. The
   * package leaves out anyone who unsubscribed. Resolve to null when they
   * cannot be looked up right now (nothing goes out until they can).
   */
  recipients: () => Promise<readonly MarketingRecipient[] | null>;
  /**
   * Sends one email. Throw (or resolve to an object with a truthy `error`)
   * when it did not go: the reason is kept, in one line, for the page.
   */
  send: (email: OutgoingEmail) => Promise<unknown>;
  /** Emails per second, per server. Default 2, under what most email services allow. */
  perSecond?: number;
  /**
   * Nothing goes out unless the server runs in production (NODE_ENV), so a
   * laptop with a copy of the database never emails real people. True only
   * for a test setup whose email service goes to a test inbox. Tests ("Send
   * me a test") go anywhere: they only reach the person sending them.
   */
  sendOutsideProduction?: boolean;
  /** The app's groups of people, when an email may be for some of them only. Use the same keys as What's New. Default: none. */
  audiences?: readonly Audience[];
  /** The time zone emails are scheduled in. Default America/Los_Angeles. */
  timeZone?: string;
  /**
   * The app's @arvo/whats-new, in the same database: new posts then go out
   * in a roundup email on their own. `pageUrl` is its What's New page and
   * `imagesPath` where its pictures are served (default /api/whats-new/images).
   * Leave it out for written emails only.
   */
  whatsNew?: Readonly<{ pageUrl: string; imagesPath?: string }> | null;
  /** Where routeHandlers are mounted. Default /api/marketing-emails. */
  basePath?: string;
  /** Where errors are written. Default console.error. */
  log?: MarketingLog;
}>;

export type ResolvedConfig<User extends MarketingUser = MarketingUser> = Readonly<{
  db: () => Promise<MarketingSql | null>;
  signedInUser: (request: Request) => Promise<User | null>;
  canManage: (user: User) => Promise<boolean>;
  siteUrl: string;
  siteHosts: readonly string[];
  brand: Readonly<{ name: string; logoUrl: string | null; color: string }>;
  from: string;
  replyTo: string | null;
  postalAddress: string;
  recipients: () => Promise<readonly MarketingRecipient[] | null>;
  send: (email: OutgoingEmail) => Promise<unknown>;
  perSecond: number;
  sendOutsideProduction: boolean;
  audiences: readonly Audience[];
  timeZone: string;
  whatsNew: Readonly<{ pageUrl: string; imagesPath: string }> | null;
  /** What the setup still lacks, in plain words for the page. Empty when it can send. */
  missing: readonly string[];
  basePath: string;
  log: MarketingLog;
}>;

/** The parts of the config that do not depend on the app's user type. */
export type ConfigCore = Omit<ResolvedConfig, 'signedInUser' | 'canManage'>;

const KEY = /^[a-z][a-z0-9_-]{0,39}$/;

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function siteOf(value: unknown): URL | null {
  try {
    const url = new URL(trimmed(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Reads the config once. Never throws: what is wrong is logged and shown on the page to the people who manage it. */
export function normalizeConfig<User extends MarketingUser>(input: MarketingEmailsConfig<User>): ResolvedConfig<User> {
  const log: MarketingLog = input.log ?? ((line, error) => (error === undefined ? console.error(line) : console.error(line, error)));
  const site = siteOf(input.siteUrl);
  const siteHosts = (input.siteHosts?.length ? input.siteHosts : site ? [site.hostname] : []).map((host) => host.trim().toLowerCase()).filter(Boolean);

  const audiences: Audience[] = [];
  for (const audience of input.audiences ?? []) {
    if (!audience || !KEY.test(audience.key) || !trimmed(audience.label) || audiences.some((a) => a.key === audience.key)) {
      log(`[Marketing emails] an audience was left out: its key must be lower case letters, digits, - or _ (at most 40), with a label, once: ${JSON.stringify(audience)}`);
      continue;
    }
    audiences.push({ key: audience.key, label: trimmed(audience.label) });
  }

  let timeZone = trimmed(input.timeZone) || 'America/Los_Angeles';
  if (!isTimeZone(timeZone)) {
    log(`[Marketing emails] ${JSON.stringify(timeZone)} is not a time zone this server knows; America/Los_Angeles is used.`);
    timeZone = 'America/Los_Angeles';
  }

  const missing: string[] = [];
  if (!site) missing.push("The site's address (siteUrl), for the links in the emails");
  if (!trimmed(input.from).includes('@')) missing.push('The address the emails come from (from)');
  if (!trimmed(input.postalAddress)) missing.push("The company's postal address (postalAddress): the law requires it in every marketing email");
  if (typeof input.send !== 'function') missing.push('A way to send email (send)');
  if (typeof input.recipients !== 'function') missing.push('Who may get the emails (recipients)');
  if (missing.length) log(`[Marketing emails] not set up, so nothing will go out: ${missing.join('; ')}`);

  const whatsNewPage = trimmed(input.whatsNew?.pageUrl);
  return {
    db: async () => (await input.db()) ?? null,
    signedInUser: input.signedInUser,
    canManage: async (user) => Boolean(await input.canManage(user)),
    siteUrl: site ? site.origin : '',
    siteHosts,
    brand: { name: trimmed(input.brand?.name) || 'Our app', logoUrl: trimmed(input.brand?.logoUrl) || null, color: brandColor(input.brand?.color) },
    from: trimmed(input.from),
    replyTo: trimmed(input.replyTo) || null,
    postalAddress: trimmed(input.postalAddress),
    recipients: typeof input.recipients === 'function' ? input.recipients : async () => null,
    send: typeof input.send === 'function' ? input.send : async () => ({ error: 'No way to send email is set up.' }),
    perSecond: Math.max(0.1, input.perSecond ?? 2),
    sendOutsideProduction: input.sendOutsideProduction === true,
    audiences,
    timeZone,
    whatsNew: input.whatsNew
      ? { pageUrl: whatsNewPage.startsWith('/') || siteOf(whatsNewPage) ? whatsNewPage : `/${whatsNewPage || 'whats-new'}`, imagesPath: (trimmed(input.whatsNew.imagesPath) || '/api/whats-new/images').replace(/\/+$/, '') }
      : null,
    missing,
    basePath: (trimmed(input.basePath) || '/api/marketing-emails').replace(/\/+$/, ''),
    log,
  };
}

/** A path on the site as a full address. */
export function absoluteUrl(config: Pick<ResolvedConfig, 'siteUrl'>, path: string): string {
  try {
    return new URL(path, config.siteUrl || 'https://example.invalid').href;
  } catch {
    return path;
  }
}

/** What the email preview and the sender need to draw an email for this app. */
export function emailBrand(config: ConfigCore): EmailBrand {
  return {
    name: config.brand.name,
    logoUrl: config.brand.logoUrl,
    color: config.brand.color,
    siteUrl: config.siteUrl,
    postalAddress: config.postalAddress,
    pageUrl: absoluteUrl(config, config.whatsNew?.pageUrl ?? '/'),
  };
}

/** True when the email (by its audience list) is for this person. An empty list is everyone. */
export function isFor(audience: readonly string[], personAudiences: readonly string[] | null | undefined): boolean {
  if (!audience.length) return true;
  const mine = personAudiences ?? [];
  return audience.some((key) => mine.includes(key));
}
