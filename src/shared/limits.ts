// Every size and count the package holds to, in one place, so the forms,
// the routes and the database checks say the same thing.

export const LIMITS = {
  /** A written email's HTML. Pictures go in by link. */
  html: 1_000_000,
  subject: 90,
  /** Over this, most phones cut the subject off; the editor says so but still saves. */
  subjectShort: 45,
  preheader: 140,
  headline: 120,
  /** A roundup's line at the top. */
  intro: 1000,
  /** A picture: PNG, JPEG, GIF or WebP up to 2 MB. */
  imageBytes: 2 * 1024 * 1024,
} as const;

/** Test emails one person may send in an hour. */
export const TESTS_PER_HOUR = 10;
