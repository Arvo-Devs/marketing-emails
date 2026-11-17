-- The one table of @arvo/whats-new that the roundup reads, as its
-- migration 0001 makes it, so the roundup tests run without that package.
-- Only the columns the roundup reads matter; keep them in step with it.
create table if not exists whats_new_posts (
  id uuid primary key,
  title text not null,
  summary text not null default '',
  html text not null,
  cover_image_id uuid,
  audience text[] not null default '{}',
  status text not null default 'draft',
  published_at timestamptz,
  in_email boolean not null default true,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
