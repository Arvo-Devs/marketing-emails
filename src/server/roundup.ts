// The roundup's posts, read from @arvo/whats-new's table in the same
// database (never written: which posts went in which roundup is kept in
// marketing_roundup_posts). Nothing here runs without `whatsNew` in the
// config. If What's New's table isn't there, there are simply no posts, and
// the page says why.
import type { ConfigCore, MarketingSql } from '../config';
import { absoluteUrl } from '../config';
import type { PostView } from '../shared/api';

export type WhatsNewPostRow = {
  id: string;
  title: string;
  summary: string;
  cover_image_id: string | null;
  audience: string[];
  published_at: Date;
};

/** True when the error says What's New's table isn't in this database. */
export function missingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

/** A What's New post as the roundup shows it: its picture from What's New's own address. */
export function roundupPost(config: Pick<ConfigCore, 'siteUrl' | 'whatsNew'>, row: WhatsNewPostRow, fullImages = false): PostView {
  const images = config.whatsNew?.imagesPath ?? '/api/whats-new/images';
  const cover = row.cover_image_id ? `${images}/${row.cover_image_id}` : null;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    coverUrl: cover && fullImages ? absoluteUrl(config, cover) : cover,
    publishedAt: row.published_at.toISOString(),
  };
}

/**
 * Live posts with "Put it in the next roundup" ticked that no roundup has
 * taken yet, newest first, with their groups. Locked for the caller's
 * transaction when `lock` is set.
 */
export async function waitingPostRows(sql: MarketingSql, config: Pick<ConfigCore, 'whatsNew'>, lock = false): Promise<WhatsNewPostRow[]> {
  if (!config.whatsNew) return [];
  try {
    const rows = await sql<WhatsNewPostRow[]>`
      select p.id, p.title, p.summary, p.cover_image_id, p.audience, p.published_at from whats_new_posts p
      where p.status = 'published' and p.published_at <= now() and p.in_email
        and not exists (select 1 from marketing_roundup_posts r where r.post_id = p.id)
      order by p.published_at desc, p.id
      limit 50
      ${lock ? sql`for update of p` : sql``}
    `;
    return [...rows];
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

/** The posts a roundup carried (or carries, once it started), newest first. */
export async function roundupPostRows(sql: MarketingSql, emailId: string): Promise<WhatsNewPostRow[]> {
  try {
    const rows = await sql<WhatsNewPostRow[]>`
      select p.id, p.title, p.summary, p.cover_image_id, p.audience, p.published_at
      from marketing_roundup_posts r join whats_new_posts p on p.id = r.post_id
      where r.email_id = ${emailId}
      order by p.published_at desc, p.id
    `;
    return [...rows];
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

/** True when What's New's table is in this database. */
export async function whatsNewInstalled(sql: MarketingSql): Promise<boolean> {
  const rows = await sql<{ found: string | null }[]>`select to_regclass('whats_new_posts')::text as found`;
  return Boolean(rows[0]?.found);
}
