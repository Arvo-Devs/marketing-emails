// What the routes answer and accept, shared by the server and the pages.
// Times are ISO 8601 strings.
import type { Cadence } from './schedule';

/** A group of people the app names ("Agencies", "Creators"). A post or email for some groups reaches only them; one for none reaches everyone. */
export type Audience = Readonly<{ key: string; label: string }>;

/** A What's New post as the roundup shows it (read from @arvo/whats-new's table). */
export type PostView = Readonly<{
  id: string;
  title: string;
  summary: string;
  coverUrl: string | null;
  publishedAt: string;
}>;

/** The words the page fills in the email prompt with. */
export type PromptFacts = Readonly<{ appName: string; siteUrl: string }>;

export type EmailKind = 'roundup' | 'feature';
export type EmailStatus = 'queued' | 'sending' | 'sent' | 'stopped';

/** An email waiting its turn, or going out now. */
export type QueuedEmail = Readonly<{
  id: string;
  kind: EmailKind;
  status: EmailStatus;
  subject: string;
  preheader: string;
  /** A roundup's headline and line at the top. */
  headline: string;
  body: string;
  /** A written email's HTML. */
  html: string;
  audience: readonly string[];
  /** Queued: the slot it is lined up for, if the schedule reaches it. Sending: its slot. */
  slotAt: string | null;
  /** A roundup: the posts it carries now (queued) or carried (sent). */
  posts: readonly PostView[];
  /** Sending: how far it got. */
  progress: Readonly<{ sent: number; failed: number }> | null;
  /** Sending stopped for a while: what went wrong, and when it tries again. */
  lastError: string | null;
  retryAfter: string | null;
}>;

/** An email that went out (or was stopped part way). */
export type SentEmail = Readonly<{
  id: string;
  kind: EmailKind;
  status: 'sent' | 'stopped';
  subject: string;
  slotAt: string | null;
  finishedAt: string | null;
  sent: number;
  failed: number;
  unsubscribed: number;
}>;

export type MarketingSettings = Readonly<{
  sending: boolean;
  cadence: Cadence;
  weekday: number;
  time: string;
  firstSendOn: string | null;
  roundups: boolean;
  timeZone: string;
}>;

/** What the email preview needs to draw an email the way it goes out. */
export type EmailBrand = Readonly<{
  name: string;
  logoUrl: string | null;
  color: string;
  siteUrl: string;
  postalAddress: string;
  /** The What's New page, as a full address (the site when the app has none). */
  pageUrl: string;
}>;

export type ManageEmailsAnswer = Readonly<{
  /** What the app's setup still needs before anything can go out, in plain words. Empty when it is ready. */
  missing: readonly string[];
  settings: MarketingSettings;
  /** "Every other Tuesday at 10:00 AM" */
  scheduleText: string;
  /** The next few slots. */
  nextSlots: readonly string[];
  queue: readonly QueuedEmail[];
  sending: QueuedEmail | null;
  sent: readonly SentEmail[];
  audience: Readonly<{ count: number | null; unsubscribed: number }>;
  brand: EmailBrand;
  audiences: readonly Audience[];
  /** The signed-in person's address, where "Send me a test" goes. */
  testTo: string | null;
  /** Live What's New posts waiting for the next roundup. */
  roundupPosts: readonly PostView[];
  /** False when the app has no What's New (or its table isn't in this database): no roundups, only written emails. */
  whatsNew: boolean;
  facts: PromptFacts;
}>;

export type EmailInput =
  | Readonly<{ kind: 'feature'; subject: string; preheader: string; html: string; audience: readonly string[] }>
  | Readonly<{ kind: 'roundup'; subject: string; preheader: string; headline: string; body: string }>;

export type SettingsInput = Readonly<
  Partial<{ sending: boolean; cadence: Cadence; weekday: number; time: string; roundups: boolean }>
>;

/** GET me/emails: the signed-in person's own choice. `available` is false when the app sends no marketing emails. */
export type MyEmailsAnswer = Readonly<{ available: boolean; subscribed: boolean }>;

export type ImageAnswer = Readonly<{ id: string; url: string; fullUrl: string }>;

/** GET manage/images: the pictures uploaded so far, newest first, with the links to put in HTML. */
export type ImagesAnswer = Readonly<{ images: readonly Readonly<{ id: string; url: string; fullUrl: string; type: string; bytes: number; createdAt: string }>[] }>;

export type TestAnswer = Readonly<{ to: string }>;
