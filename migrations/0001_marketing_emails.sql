-- @arvo/marketing-emails 0001: the schedule, the line of emails, who got
-- each one, who said no, and the pictures emails use.
--
-- Nothing here keeps a name or an email address. People are kept by the
-- app's account id; the sender reads addresses live from the app, and
-- forgetAccount() removes an account's rows when the app deletes it.
--
-- With @arvo/whats-new in the same database, the roundup reads its posts
-- (whats_new_posts) and never writes them: which posts went in which
-- roundup is kept here, in marketing_roundup_posts.
--
-- Never edit this file once applied: a later version adds a new one.

-- Pictures for written emails, uploaded on the page and put in the HTML by
-- their link. Served at <basePath>/images/<id> to anyone (they go out in
-- emails), so never anything private.
create table if not exists marketing_images (
  id uuid primary key,
  content_type text not null,
  bytes bytea not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint marketing_images_type_check check (content_type in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  constraint marketing_images_size_check check (octet_length(bytes) between 1 and 2097152)
);

-- One row per marketing email: waiting in the line, going out, or sent.
-- kind 'roundup' is drawn from What's New posts (headline and body are its
-- own words at the top); 'feature' is HTML someone pasted. The footer with
-- the unsubscribe link and the postal address is added when it is sent.
-- slot_at is the scheduled time it went out in: one email per slot, ever.
create table if not exists marketing_emails (
  id uuid primary key,
  kind text not null,
  status text not null default 'queued',
  position double precision not null default 0,
  subject text not null default '',
  preheader text not null default '',
  headline text not null default '',
  body text not null default '',
  html text not null default '',
  audience text[] not null default '{}',
  slot_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  retry_after timestamptz,
  last_error text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_emails_kind_check check (kind in ('roundup', 'feature')),
  constraint marketing_emails_status_check check (status in ('queued', 'sending', 'sent', 'stopped')),
  constraint marketing_emails_slot_check check (status = 'queued' or slot_at is not null),
  constraint marketing_emails_subject_check check (char_length(subject) <= 90),
  constraint marketing_emails_preheader_check check (char_length(preheader) <= 140),
  constraint marketing_emails_headline_check check (char_length(headline) <= 120),
  constraint marketing_emails_body_check check (char_length(body) <= 1000),
  constraint marketing_emails_html_check check (char_length(html) <= 1000000),
  constraint marketing_emails_feature_check check (kind = 'roundup' or char_length(html) > 0)
);
create unique index if not exists marketing_emails_slot_idx on marketing_emails (slot_at) where slot_at is not null;
-- At most one roundup waits at a time; it gathers every post until it goes.
create unique index if not exists marketing_emails_one_roundup_idx on marketing_emails (kind) where kind = 'roundup' and status = 'queued';
create index if not exists marketing_emails_queue_idx on marketing_emails (position) where status = 'queued';

-- Which What's New posts went in which roundup: each post in one roundup,
-- once. post_id is @arvo/whats-new's id, so it has no foreign key here.
create table if not exists marketing_roundup_posts (
  email_id uuid not null references marketing_emails (id) on delete cascade,
  post_id uuid not null,
  primary key (email_id, post_id)
);
create unique index if not exists marketing_roundup_posts_post_idx on marketing_roundup_posts (post_id);

-- The schedule and the on/off switch: one row.
create table if not exists marketing_settings (
  id smallint primary key default 1,
  sending boolean not null default false,
  cadence text not null default 'every_2_weeks',
  weekday smallint not null default 2,
  send_time text not null default '10:00',
  first_send_on date,
  roundups boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint marketing_settings_one_row check (id = 1),
  constraint marketing_settings_cadence_check check (cadence in ('weekly', 'every_2_weeks', 'monthly')),
  constraint marketing_settings_weekday_check check (weekday between 0 and 6),
  constraint marketing_settings_time_check check (send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- One row per person an email went (or is going) to. The row is written
-- before the email is sent, so nobody ever gets the same email twice, even
-- with several servers sending at once. token is the person's own
-- unsubscribe link for this email. error is one line from the email service.
create table if not exists marketing_deliveries (
  email_id uuid not null references marketing_emails (id) on delete cascade,
  user_id text not null,
  status text not null default 'sending',
  error text,
  token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (email_id, user_id),
  constraint marketing_deliveries_status_check check (status in ('sending', 'sent', 'failed'))
);
create unique index if not exists marketing_deliveries_token_idx on marketing_deliveries (token);
create index if not exists marketing_deliveries_user_idx on marketing_deliveries (user_id);

-- People who said no to marketing emails, from an email's link or the app's
-- settings. They get none until they say yes again.
create table if not exists marketing_unsubscribes (
  user_id text primary key,
  email_id uuid references marketing_emails (id) on delete set null,
  unsubscribed_at timestamptz not null default now()
);
