/**
 * The routes, mounted under basePath (default /api/marketing-emails) by one
 * catch-all route file in the app.
 *
 * Anyone signed in:
 *   GET    me/emails              their own yes or no to marketing emails
 *   POST   me/emails { subscribed }
 *
 * Admin › Marketing emails (canManage):
 *   GET    manage                 the schedule, the line, what went out
 *   POST   manage/settings
 *   POST   manage/emails          a new written email, at the end of the line
 *   POST   manage/emails/<id>     a change to a waiting email
 *   DELETE manage/emails/<id>
 *   POST   manage/emails/<id>/move { direction: 'up' | 'down' }
 *   POST   manage/emails/<id>/stop
 *   GET    manage/emails/<id>/view  a sent email as it went out
 *   POST   manage/test            sends the email in the body to the person asking, marked as a test
 *   GET    manage/images          the pictures so far, with their links
 *   POST   manage/images          a picture, as the request body
 *
 * Anyone, no sign-in:
 *   GET    images/<id>            a picture (they go out in emails)
 *   GET    unsubscribe?t=         the page an email's Unsubscribe link opens
 *   POST   unsubscribe?t=         its button, and inboxes' one-click Unsubscribe
 *
 * Changes are only taken from the site's own pages (siteHosts), except the
 * unsubscribe link, which carries its own secret. Every answer is no-store
 * except pictures.
 */
import type { MarketingSql, MarketingUser, ResolvedConfig } from '../config';
import { emailBrand } from '../config';
import type { ManageEmailsAnswer, PromptFacts } from '../shared/api';
import { campaignName, renderEmail } from '../shared/email';
import { LIMITS } from '../shared/limits';
import { describeSchedule } from '../shared/schedule';
import { isFieldError, isUuid } from './fields';
import { apiError, fromOwnPage, invalid, json, manager, noContent, notFound, oneLine, readBytesUpTo, readJson, signedIn, unavailable } from './http';
import { imageResponse, listImages, saveImage, sniffImage } from './images';
import {
  createEmail,
  deleteEmail,
  isUnsubscribed,
  moveEmail,
  postsOf,
  queueView,
  readEmailInput,
  readSettings,
  readSettingsInput,
  resubscribe,
  saveSettings,
  sendingView,
  sentEmail,
  sentView,
  stopEmail,
  syncRoundup,
  unsubscribe,
  unsubscribedCount,
  updateEmail,
} from './marketing';
import { htmlPage, UNSUBSCRIBE_WORDS } from './pages';
import { whatsNewInstalled } from './roundup';
import type { Sender } from './sender';

export type RouteHandler = (request: Request) => Promise<Response>;
export type MarketingRouteHandlers = Readonly<{ GET: RouteHandler; POST: RouteHandler; DELETE: RouteHandler }>;

const AUDIENCE_CACHE_MS = 5 * 60 * 1000;
/** A request that carries an email's HTML: the page itself, written as JSON (quotes and line breaks escaped), plus the other fields. */
const HTML_BODY_MAX = LIMITS.html * 2 + 64 * 1024;

/** The address a picture is served at: on the site (for the page), or in full (for emails and for pasting into HTML). */
export function imagePath(config: Pick<ResolvedConfig, 'basePath' | 'siteUrl'>, id: string, full = false): string {
  const path = `${config.basePath}/images/${id}`;
  return full && config.siteUrl ? `${config.siteUrl}${path}` : path;
}

export function createRouteHandlers<User extends MarketingUser>(config: ResolvedConfig<User>, sender: Sender): MarketingRouteHandlers {
  let audienceCache: { at: number; ids: string[] | null } | null = null;
  const facts: PromptFacts = { appName: config.brand.name, siteUrl: config.siteUrl };

  function fieldError(error: { error: string; field: string }): Response {
    return invalid(error.error, error.field);
  }

  async function audienceCount(sql: MarketingSql): Promise<number | null> {
    if (!audienceCache || Date.now() - audienceCache.at > AUDIENCE_CACHE_MS) {
      let ids: string[] | null = null;
      try {
        const list = await config.recipients();
        if (Array.isArray(list)) {
          const emails = new Set<string>();
          ids = [];
          for (const person of list) {
            const email = typeof person?.email === 'string' ? person.email.trim().toLowerCase() : '';
            if (!person?.id || !email.includes('@') || emails.has(email)) continue;
            emails.add(email);
            ids.push(person.id);
          }
        }
      } catch (error) {
        config.log('[Marketing emails] the app could not list who gets the emails', error);
      }
      audienceCache = { at: Date.now(), ids };
    }
    if (!audienceCache.ids) return null;
    const unsubscribed = new Set((await sql<{ user_id: string }[]>`select user_id from marketing_unsubscribes`).map((row) => row.user_id));
    return audienceCache.ids.filter((id) => !unsubscribed.has(id)).length;
  }

  // ---- anyone signed in ----

  async function myEmails(request: Request): Promise<Response> {
    const ctx = await signedIn(request, config);
    if (ctx instanceof Response) return ctx;
    return json({ available: true, subscribed: !(await isUnsubscribed(ctx.sql, ctx.user.id)) });
  }

  async function setMyEmails(request: Request): Promise<Response> {
    const ctx = await signedIn(request, config);
    if (ctx instanceof Response) return ctx;
    const body = await readJson(request, 1024);
    if (body instanceof Response) return body;
    if (typeof body.subscribed !== 'boolean') return invalid('Say yes or no.', 'subscribed');
    if (ctx.user.viewedAs) return apiError('permission', 'viewing_as', "You're viewing as someone else, so their email choice stays theirs.");
    if (body.subscribed) await resubscribe(ctx.sql, ctx.user.id);
    else await unsubscribe(ctx.sql, ctx.user.id, null);
    return json({ available: true, subscribed: body.subscribed });
  }

  // ---- Admin › Marketing emails ----

  async function manage(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const { sql } = ctx;
    const settings = await readSettings(sql, config);
    await syncRoundup(sql, config, settings);
    const [queue, sending, sent, count, unsubscribed, hasWhatsNew] = await Promise.all([
      queueView(sql, config, settings),
      sendingView(sql, config),
      sentView(sql, config),
      audienceCount(sql),
      unsubscribedCount(sql),
      config.whatsNew ? whatsNewInstalled(sql) : Promise.resolve(false),
    ]);
    const answer: ManageEmailsAnswer = {
      missing: config.missing,
      settings,
      scheduleText: describeSchedule(settings),
      nextSlots: queue.nextSlots,
      queue: queue.queue,
      sending,
      sent,
      audience: { count, unsubscribed },
      brand: emailBrand(config),
      audiences: config.audiences,
      testTo: typeof ctx.user.email === 'string' && ctx.user.email.includes('@') ? ctx.user.email : null,
      roundupPosts: queue.roundupPosts,
      whatsNew: hasWhatsNew,
      facts,
    };
    return json(answer);
  }

  async function changeSettings(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const body = await readJson(request, 2048);
    if (body instanceof Response) return body;
    const input = readSettingsInput(body);
    if (isFieldError(input)) return fieldError(input);
    if (input.sending && config.missing.length) {
      return apiError('invalid_request', 'not_set_up', "Sending can't start until the setup is finished.", { hint: config.missing.join('; ') });
    }
    const settings = await saveSettings(ctx.sql, config, input, ctx.user.id);
    await syncRoundup(ctx.sql, config, settings);
    return json({ settings });
  }

  async function newEmail(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const body = await readJson(request, HTML_BODY_MAX);
    if (body instanceof Response) return body;
    const input = readEmailInput(body, config);
    if (isFieldError(input)) return fieldError(input);
    if (input.kind !== 'feature') return invalid("The roundup is made from What's New posts on its own.", 'kind');
    return json({ id: await createEmail(ctx.sql, input, ctx.user.id) }, 201);
  }

  async function changeEmail(request: Request, id: string): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const body = await readJson(request, HTML_BODY_MAX);
    if (body instanceof Response) return body;
    const input = readEmailInput(body, config);
    if (isFieldError(input)) return fieldError(input);
    const out = await updateEmail(ctx.sql, id, input, ctx.user.id);
    if (out === null) return apiError('not_found', 'email_not_waiting', 'That email is not waiting anymore: it went out or was removed.');
    if (out === 'kind') return invalid('That is the other kind of email.', 'kind');
    return json({ id });
  }

  async function removeEmail(request: Request, id: string): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    if (!(await deleteEmail(ctx.sql, id))) return apiError('not_found', 'email_not_waiting', 'That email is not waiting anymore: it went out or was removed.');
    return noContent();
  }

  async function move(request: Request, id: string): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const body = await readJson(request, 1024);
    if (body instanceof Response) return body;
    if (body.direction !== 'up' && body.direction !== 'down') return invalid('Move it up or down.', 'direction');
    if (!(await moveEmail(ctx.sql, id, body.direction))) return apiError('invalid_request', 'cannot_move', "It can't move that way.");
    return noContent();
  }

  async function stop(request: Request, id: string): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    if (!(await stopEmail(ctx.sql, id, ctx.user.id))) return apiError('not_found', 'email_not_sending', 'That email is not going out right now.');
    return noContent();
  }

  async function view(request: Request, id: string): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const row = await sentEmail(ctx.sql, id);
    if (!row) return apiError('not_found', 'email_not_found', 'That email is gone.');
    const content =
      row.kind === 'roundup'
        ? { kind: 'roundup' as const, subject: row.subject, preheader: row.preheader, headline: row.headline, body: row.body, posts: await postsOf(ctx.sql, config, row.id, true) }
        : { kind: 'feature' as const, subject: row.subject, preheader: row.preheader, html: row.html };
    const rendered = renderEmail(content, emailBrand(config), { unsubscribeUrl: '#', campaign: campaignName(content, row.slot_at ?? new Date()) });
    return json({ subject: rendered.subject, html: rendered.html });
  }

  async function test(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    if (config.missing.length) {
      return apiError('invalid_request', 'not_set_up', "Tests can't go out until the setup is finished.", { hint: config.missing.join('; ') });
    }
    const to = typeof ctx.user.email === 'string' ? ctx.user.email.trim() : '';
    if (!to.includes('@')) return apiError('invalid_request', 'no_email', 'Your account has no email address to send the test to.');
    const body = await readJson(request, HTML_BODY_MAX);
    if (body instanceof Response) return body;
    const input = readEmailInput(body, config);
    if (isFieldError(input)) return fieldError(input);
    if (!sender.mayTest(ctx.user.id)) return apiError('rate_limited', 'rate_limited', 'That is 10 tests this hour. Try again later.');
    try {
      await sender.sendTest(ctx.sql, input, to);
    } catch (error) {
      config.log('[Marketing emails] a test did not send', error);
      return apiError('invalid_request', 'test_failed', `The test didn't send: ${oneLine(error)}`);
    }
    return json({ to });
  }

  async function uploadImage(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const bytes = await readBytesUpTo(request, LIMITS.imageBytes);
    if (!bytes) return apiError('invalid_request', 'image_too_big', 'That picture is over 2 MB. Make it smaller and add it again.');
    if (!bytes.byteLength) return invalid('Add a picture.', 'image');
    const type = sniffImage(bytes);
    if (!type) return apiError('invalid_request', 'image_type', 'Use a PNG, JPG, GIF or WebP picture.');
    const id = await saveImage(ctx.sql, bytes, type, ctx.user.id);
    return json({ id, url: imagePath(config, id), fullUrl: imagePath(config, id, true) }, 201);
  }

  async function images(request: Request): Promise<Response> {
    const ctx = await manager(request, config);
    if (ctx instanceof Response) return ctx;
    const list = await listImages(ctx.sql);
    return json({ images: list.map((image) => ({ ...image, url: imagePath(config, image.id), fullUrl: imagePath(config, image.id, true) })) });
  }

  // ---- anyone ----

  async function image(id: string): Promise<Response> {
    try {
      const sql = await config.db();
      if (!sql) return notFound();
      return (await imageResponse(sql, id)) ?? notFound();
    } catch (error) {
      config.log('[Marketing emails] a picture did not load', error);
      return unavailable();
    }
  }

  async function deliveryOf(sql: MarketingSql, token: string) {
    const rows = await sql<{ user_id: string; email_id: string }[]>`select user_id, email_id from marketing_deliveries where token = ${token}`;
    return rows[0] ?? null;
  }

  async function unsubscribePage(request: Request): Promise<Response> {
    const brand = config.brand.name;
    const token = new URL(request.url).searchParams.get('t') ?? '';
    if (token === 'test') return htmlPage(brand, UNSUBSCRIBE_WORDS.test());
    try {
      const sql = await config.db();
      const delivery = sql && token ? await deliveryOf(sql, token) : null;
      if (!sql || !delivery) return htmlPage(brand, UNSUBSCRIBE_WORDS.unknown());
      return htmlPage(brand, (await isUnsubscribed(sql, delivery.user_id)) ? UNSUBSCRIBE_WORDS.done(brand) : UNSUBSCRIBE_WORDS.ask(brand));
    } catch (error) {
      config.log('[Marketing emails] the unsubscribe page did not load', error);
      return htmlPage(brand, UNSUBSCRIBE_WORDS.failed(), 503);
    }
  }

  async function unsubscribePost(request: Request): Promise<Response> {
    const brand = config.brand.name;
    const token = new URL(request.url).searchParams.get('t') ?? '';
    const bytes = await readBytesUpTo(request, 2048);
    const form = new URLSearchParams(bytes ? Buffer.from(bytes).toString('utf8') : '');
    const oneClick = form.get('List-Unsubscribe') === 'One-Click';
    if (token === 'test') return oneClick ? new Response('This was a test email.', { status: 200 }) : htmlPage(brand, UNSUBSCRIBE_WORDS.test());
    try {
      const sql = await config.db();
      const delivery = sql && token ? await deliveryOf(sql, token) : null;
      if (!sql || !delivery) return oneClick ? new Response('Unknown link.', { status: 404 }) : htmlPage(brand, UNSUBSCRIBE_WORDS.unknown());
      if (!oneClick && form.get('action') === 'resubscribe') {
        await resubscribe(sql, delivery.user_id);
        return htmlPage(brand, UNSUBSCRIBE_WORDS.back(brand));
      }
      await unsubscribe(sql, delivery.user_id, delivery.email_id);
      return oneClick ? new Response('Unsubscribed.', { status: 200, headers: { 'cache-control': 'no-store' } }) : htmlPage(brand, UNSUBSCRIBE_WORDS.done(brand));
    } catch (error) {
      config.log('[Marketing emails] an unsubscribe did not go through', error);
      return oneClick ? new Response('Try again later.', { status: 503 }) : htmlPage(brand, UNSUBSCRIBE_WORDS.failed(), 503);
    }
  }

  // ---- routing ----

  /** The route under basePath as its parts: [] is the base itself. Null outside basePath. */
  function partsOf(request: Request): string[] | null {
    const { pathname } = new URL(request.url);
    const base = config.basePath;
    if (base && pathname !== base && !pathname.startsWith(`${base}/`)) return null;
    return pathname
      .slice(base.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  }

  async function route(method: 'GET' | 'POST' | 'DELETE', request: Request): Promise<Response> {
    const parts = partsOf(request);
    if (!parts) return notFound();
    const path = parts.join('/');
    const [a, b, c, d] = parts;

    if (method === 'GET') {
      if (path === 'me/emails') return myEmails(request);
      if (path === 'manage') return manage(request);
      if (path === 'manage/images') return images(request);
      if (path === 'unsubscribe') return unsubscribePage(request);
      if (a === 'images' && b && parts.length === 2) return image(b);
      if (a === 'manage' && b === 'emails' && isUuid(c) && d === 'view' && parts.length === 4) return view(request, c);
      return notFound();
    }

    if (path === 'unsubscribe' && method === 'POST') return unsubscribePost(request);
    // Every other change comes from the site's own pages, never from another site the person happens to have open.
    if (!fromOwnPage(request.headers, config.siteHosts)) {
      return apiError('permission', 'missing_permission', 'This request came from a page we do not trust.');
    }

    if (method === 'POST') {
      if (path === 'me/emails') return setMyEmails(request);
      if (path === 'manage/settings') return changeSettings(request);
      if (path === 'manage/test') return test(request);
      if (path === 'manage/emails') return newEmail(request);
      if (path === 'manage/images') return uploadImage(request);
      if (a === 'manage' && b === 'emails' && isUuid(c) && parts.length === 3) return changeEmail(request, c);
      if (a === 'manage' && b === 'emails' && isUuid(c) && d === 'move' && parts.length === 4) return move(request, c);
      if (a === 'manage' && b === 'emails' && isUuid(c) && d === 'stop' && parts.length === 4) return stop(request, c);
      return notFound();
    }

    if (a === 'manage' && b === 'emails' && isUuid(c) && parts.length === 3) return removeEmail(request, c);
    return notFound();
  }

  function handler(method: 'GET' | 'POST' | 'DELETE'): RouteHandler {
    return async (request: Request) => {
      try {
        return await route(method, request);
      } catch (error) {
        // An app hook or the database threw where nothing else caught it: still a plain answer, never a crash.
        config.log('[Marketing emails] a request was not answered', error);
        return unavailable();
      }
    };
  }

  return { GET: handler('GET'), POST: handler('POST'), DELETE: handler('DELETE') };
}
