# @arvo/marketing-emails

**Marketing emails** for your app, on a steady schedule. Built like
[@arvo/traffic](https://github.com/Arvo-Devs/traffic) and
[@arvo/signup-funnel](https://github.com/Arvo-Devs/signup-funnel): one
package, installed in each app pinned to a commit.

It gives an app four things:

- **Admin › Marketing emails**: a steady schedule ("every other Tuesday at
  10 AM"), a line of emails each lined up on its date, and a switch. While
  sending is on, the first email in line goes out on each date to everyone
  who allows marketing emails, with nobody clicking anything.
- **Written emails as HTML**: **Copy the prompt**, run it in the product's repo with the best AI model at the
  time, paste the email it makes (or drop its file), and see it exactly as it
  arrives. **The unsubscribe link, the postal address and the inbox's own
  one-click Unsubscribe are added to every email**, so the pasted HTML never
  carries them. **Send me a test**, **Sent** with what each email reached,
  and **Ideas**: the rules of a good marketing email and examples to start
  from, for a made-up product.
- **The roundup**, with [@arvo/whats-new](https://github.com/Arvo-Devs/whats-new)
  in the same app: new What's New posts go out in a roundup email on their
  own, each with its title, its one line and its picture, linked to the post.
- **Pictures** to put in an email by link, and **a settings switch** for
  each person's own yes or no, the same list the emails' Unsubscribe links
  change.

**Every app keeps its own rows in its own database, and sends with its own
email service.** Nothing goes to a central server, and no name or email
address is ever stored: people are kept by account id, and the app's own
tables are read live.

## Installing

Pin to a **commit SHA** (tags move; the SHA is the pin):

```jsonc
// package.json
"dependencies": {
  "@arvo/marketing-emails": "github:Arvo-Devs/marketing-emails#<full-commit-sha>"
}
```

```ts
// next.config.ts: the package ships TypeScript source, and the app compiles it
transpilePackages: ["@arvo/marketing-emails"],
```

Copy `migrations/0001_marketing_emails.sql` into the app's migrations,
unchanged. Updating means reading `git diff <old-sha>..<new-sha>` here,
moving the SHA, installing, committing the lockfile, and copying any new
migration.

## Requirements

- **Next.js (App Router) and React 19**, with **@tanstack/react-query v5**
  around the page (your `QueryClientProvider`).
- **Postgres** through a [postgres.js](https://github.com/porsager/postgres)
  client nothing wraps with drizzle.
- **Tailwind CSS v4**, with `@source "../node_modules/@arvo/marketing-emails/src";`.
- **The app's pg-boss worker** (the framework's `apps/worker`), or its own
  server where it has no worker: one pass a minute sends the emails on time
  (section 4).
- **An email service the app already sends with** (Resend in most of ours),
  a From address on a domain it has verified, and the company's postal
  address (the law requires it in every marketing email).

## Theming

The page uses the same color names as the other imports, the shadcn way.
An app that already maps them has nothing to add; otherwise import
`@arvo/marketing-emails/styles/tokens.css` once. Adapting to another design
system means editing one file, `src/ui/ui-deps.ts`.

## 1. One server file

```ts
// lib/marketing-emails/marketing-emails.server.ts
import { createMarketingEmails } from '@arvo/marketing-emails';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const marketingEmails = createMarketingEmails({
  db: () => siteSql, // postgres.js, not wrapped by drizzle
  signedInUser: async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    return {
      id: session.user.id,
      email: session.user.email, // where "Send me a test" goes
      viewedAs: Boolean(session.session.impersonatedBy), // staff looking as a customer can't change their choice
    };
  },
  canManage: (user) => hasMassAccess(user.id),
  siteUrl: 'https://yourapp.com',
  brand: { name: 'Your app', logoUrl: 'https://yourapp.com/email-logo.png', color: '#4f46e5' },
  from: 'Your app <updates@news.yourapp.com>',
  replyTo: 'support@yourapp.com',
  postalAddress: '123 Example Street, Anytown, CA 90000',
  // Everyone who may get marketing email: active accounts with a confirmed email.
  // The package leaves out whoever unsubscribed.
  recipients: async () => siteSql`
    select id, email from users
    where email_verified and banned is not true and deleted_at is null
  `,
  send: async (email) => {
    const { error } = await resend.emails.send({
      from: email.from,
      to: email.to,
      replyTo: email.replyTo ?? undefined,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: email.headers, // List-Unsubscribe: Gmail and Yahoo show their own button
    });
    if (error) throw new Error(error.message);
  },
  whatsNew: { pageUrl: '/dashboard/whats-new' }, // only with @arvo/whats-new
});
```

| It asks for | What to give it |
|---|---|
| `db` | The app's own Postgres, through a client drizzle doesn't wrap. |
| `signedInUser` | The app's own sign-in, checked on every request, with the person's email. |
| `canManage(user)` | Who may manage **Admin › Marketing emails**: Mass Access, or the Team import's check for that page. Everyone else gets "not found". |
| `siteUrl`, `brand` | The site's public address (links, pictures and the unsubscribe page) and the name, logo and color the roundup is drawn with. |
| `from`, `replyTo`, `postalAddress` | The sending address (on its own subdomain where you can, so complaints about marketing can't hurt sign-in codes and receipts), where replies go, and the address the law requires. |
| `recipients`, `send` | Who may get the emails, read live, and how the app sends one. `perSecond` (default 2) keeps under the email service's limit. |
| `audiences` | Optional groups, with the same keys What's New uses, so an email can be for some of them. Give each person's keys in `recipients`. |
| `whatsNew` | The app's What's New page, when it has @arvo/whats-new in the same database. Turns on the roundup. `imagesPath` if its pictures aren't at `/api/whats-new/images`. |
| `timeZone` | The time zone the schedule is in. Default `America/Los_Angeles`. |

The page lists what is still missing ("The company's postal address…"), and
sending can't be switched on until the list is empty.

## 2. Routes

```ts
// app/api/marketing-emails/[[...route]]/route.ts
import { marketingEmails } from '@/lib/marketing-emails/marketing-emails.server';

export const dynamic = 'force-dynamic';
export const { GET, POST, DELETE } = marketingEmails.routeHandlers;
```

**Two of its addresses are public**, because emails link to them:
`/api/marketing-emails/images/<id>` and `/api/marketing-emails/unsubscribe`.
If the app's middleware sends signed-out requests to a sign-in page, let
these two through.

## 3. Pages

```tsx
import { MarketingEmailsManager, MarketingEmailsSetting } from '@arvo/marketing-emails/client';
```

| Where | What |
|---|---|
| Admin › Marketing emails | `<MarketingEmailsManager />` under the page title |
| The account settings page | `<MarketingEmailsSetting />` |

The calls go to `/api/marketing-emails` unless the `basePath` prop (or one
`<MarketingEmailsProvider>` around them) says otherwise.

## 4. Sending on its own

**In the app's pg-boss worker, every minute.** Scheduled work goes in the
worker, never in a cron job, so a big send can never slow the website:

```ts
// apps/worker: the app's pg-boss worker, with the same server file as the routes
import { marketingEmails } from '@repo/client/marketing-emails';

await boss.createQueue('marketing-emails');
await boss.schedule('marketing-emails', '* * * * *');
await boss.work('marketing-emails', async () => {
  await marketingEmails.sendDue();
});
```

- **A pass sends for about 50 seconds at most** and leaves the rest to the
  next minute, so a big list goes out over a few passes.
- **Several workers at once are safe**: one email per slot, and nobody ever
  gets the same email twice.
- **Nothing goes out unless the worker runs in production** (`NODE_ENV`), so
  a laptop with a copy of the database never emails real people. A test
  setup whose email service goes to a test inbox sets
  `sendOutsideProduction: true`. "Send me a test" works anywhere: it only
  reaches the person sending it.

An app with no worker runs the passes inside its web server instead, from
`instrumentation.ts` with `marketingEmails.startSending()`.

## 5. Deleting an account

Call `marketingEmails.forgetAccount(userId)` from the app's delete-account
code. It removes the account's unsubscribe and the record of the emails it
got. It never throws; false means try again later.

## 6. One unsubscribe list per app

One click stops every email someone can say no to. The list is this
package's (`marketing_unsubscribes`, kept by account id), and
`marketingEmails.unsubscribes` hands it to the app's other email imports,
like Retention emails:

```ts
// Retention emails' server file, in an app that has Marketing emails too
unsubscribes: marketingEmails.unsubscribes,
```

| Call | What it does |
|---|---|
| `unsubscribed(userIds)` | The accounts among these that said no. |
| `add(userId)` | Records a no. Twice is the same as once. |
| `remove(userId)` | Takes it back ("Subscribe again"). |

Each call throws when the database can't be reached, so the other import
sends nothing rather than guess. In an app with both, word the settings
switch for both: `<MarketingEmailsSetting description="..." />`.

## 7. The rules

**Sending**

- A new install starts with sending **off**. Nothing goes out until someone
  with the page turns it on, and the page says which email goes first, when,
  and to how many people before it does.
- The schedule names its dates ("slots"). Each slot takes the first email in
  line, one email per slot, ever. A slot missed while the server was down can
  still go out up to 6 hours late; later than that, it waits for the next.
- Everyone `recipients` lists gets each email once: not anyone who
  unsubscribed, not a bad address, not the same address twice. The record of
  each person is written before their email is sent, so a crash or a second
  server can never send anyone the same email twice. One left unconfirmed for
  15 minutes counts as failed and is never sent again.
- **Five refusals in a row** means the email service is refusing everything
  (a bad key, a domain not verified): those five are given back, the page
  says why, and it tries again in 10 minutes. Nobody is skipped for it.
  **Stop sending** ends an email part way: nobody it hasn't reached gets it.

**Written emails**

- The HTML someone pasted (up to 1 MB), with a subject and a preview line.
  When it goes out, scripts, frames and forms are taken out, the site's own
  links are tagged `utm_source=email` for Traffic, and the hidden preview
  line and the footer (why they got it, Unsubscribe, the postal address) are
  added. A fragment without `<html>` gets a page around it.
- Email apps throw away drawings made of HTML and CSS, so pictures are real
  images, added under **Pictures** and used by their link. They are kept in
  the app's database and served to anyone, so never anything private.
- **Send me a test** sends what is in the editor to the person editing,
  marked as a test, at most 10 an hour.

**The roundup** (with @arvo/whats-new)

- While roundups are on, a roundup joins the end of the line as soon as a
  live What's New post with "Put it in the next roundup" ticked is waiting,
  and gathers every waiting post until it goes. Drafts and scheduled posts
  never wait for it.
- It freezes its posts when it starts sending; later posts wait for the next
  one. Each post goes in one roundup, once (kept here, in
  `marketing_roundup_posts`: this package never writes What's New's tables).
- Each person gets only the posts for their groups, and someone who may see
  none of them is skipped. A roundup can be moved but not removed (leave a
  post out from its editor on What's New, or turn roundups off).

**Unsubscribing**

- Every email has the person's own link in its footer, and the
  `List-Unsubscribe` headers Gmail and Yahoo ask bulk senders for. Opening
  the link only asks (mail scanners open every link); the button, or the
  inbox's own Unsubscribe button, does it. **Subscribe again** undoes it.
- `<MarketingEmailsSetting />` changes the same list, so the two always agree.
- It is the app's one list (section 6): a no recorded by another of the
  app's email imports stops these emails too, and the other way round.

## Tests

`bun test` runs the rules without a database. With
`MARKETING_TEST_PG_URL` (a Postgres the tests may create databases on) it
also runs everything against a real database, with a copy of What's New's
posts table for the roundup: the line, the sender with two servers at once,
crashes, refusals, stopping and unsubscribing. CI runs both.
