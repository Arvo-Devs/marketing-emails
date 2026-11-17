// Checks for what the editor sends: each answers the value, or which field
// is wrong and what to tell the person.
import type { ConfigCore } from '../config';
import { looksLikeHtml } from '../shared/html';
import { LIMITS } from '../shared/limits';

/** A field the editor sent that cannot be saved: what to tell the person, and which field. */
export type FieldError = Readonly<{ error: string; field: string }>;

export function isFieldError(value: unknown): value is FieldError {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { error?: unknown }).error === 'string';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** The app's groups an email is for: only keys the app named. */
export function readAudience(body: Record<string, unknown>, config: Pick<ConfigCore, 'audiences'>): string[] | FieldError {
  const raw = body.audience;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'Pick who it is for from the list.', field: 'audience' };
  const keys = [...new Set(raw.filter((key): key is string => typeof key === 'string'))];
  if (keys.length !== raw.length || keys.some((key) => !config.audiences.some((a) => a.key === key))) {
    return { error: 'Pick who it is for from the list.', field: 'audience' };
  }
  return keys;
}

/** Pasted HTML, checked: there, HTML, and not too big. */
export function readHtml(value: unknown, field = 'html'): string | FieldError {
  const html = typeof value === 'string' ? value.trim() : '';
  if (!html) return { error: 'Paste the HTML, or drop the .html file here.', field };
  if (!looksLikeHtml(html)) return { error: "That isn't HTML. Paste the whole file the prompt made.", field };
  if (html.length > LIMITS.html) return { error: 'That HTML is over 1 MB. Put pictures in by link from Pictures instead of inside the file.', field };
  return html;
}
