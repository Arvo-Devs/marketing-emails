// When marketing emails go out. The page keeps one schedule: how often, the
// day of the week, the time, in the app's time zone. Every time it names is a
// "slot", and at most one email goes in each slot.
//
//   weekly         every week on that day
//   every_2_weeks  every other week on that day, counted from firstSendOn
//   monthly        the first of that day in each month (the first Tuesday)
//
// Pure date math with Intl only, so the page and the sender agree to the
// minute, across daylight saving changes, with no library. Imports nothing
// from Node.

export type Cadence = 'weekly' | 'every_2_weeks' | 'monthly';

export const CADENCES: readonly Cadence[] = ['weekly', 'every_2_weeks', 'monthly'];

export type Schedule = Readonly<{
  cadence: Cadence;
  /** 0 is Sunday, 6 is Saturday. */
  weekday: number;
  /** "10:00", on the 24-hour clock, in timeZone. */
  time: string;
  /** For every_2_weeks: a date (YYYY-MM-DD) one send falls on. Ignored otherwise. */
  firstSendOn: string | null;
  /** An IANA time zone, like America/Los_Angeles. */
  timeZone: string;
}>;

/** How long after its time a send may still start, when the server was down at the time. Later than this, it waits for the next slot. */
export const LATE_WINDOW_MS = 6 * 60 * 60 * 1000;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The times the page offers: on the hour and half hour from 5 AM to 10 PM, clear of the night hours when clocks change. */
export const SEND_TIMES: readonly string[] = Array.from({ length: (22 - 5) * 2 + 1 }, (_, i) => {
  const minutes = 5 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

type LocalDate = Readonly<{ y: number; m: number; d: number }>;

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the runtime knows the time zone. */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in timeZone at an instant. */
function wallClock(instant: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, hh: parts.hour! % 24, mm: parts.minute!, ss: parts.second! };
}

/** How far timeZone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time happens in timeZone. A time the clocks skip (the page never offers one) lands an hour away from it. */
export function zonedTime(date: LocalDate, time: string, timeZone: string): Date {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(date.y, date.m - 1, date.d, hh, mm);
  let instant = guess - offsetAt(guess, timeZone);
  // Near a clock change the offset at the guess and at the answer differ: one more pass settles it.
  const second = offsetAt(instant, timeZone);
  if (guess - second !== instant) instant = guess - second;
  return new Date(instant);
}

/** The date on the wall calendar in timeZone at an instant. */
export function localDate(instant: Date, timeZone: string): LocalDate {
  const w = wallClock(instant.getTime(), timeZone);
  return { y: w.y, m: w.m, d: w.d };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** "2026-11-24" for a date. */
export function isoDate(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

export function parseIsoDate(value: unknown): LocalDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return isoDate(addDays(date, 0)) === value ? date : null;
}

/** The every-2-weeks count starts here when firstSendOn is missing: the first of that weekday in 2026. */
function defaultAnchor(weekday: number): LocalDate {
  const start = { y: 2026, m: 1, d: 1 };
  return addDays(start, (weekday - weekdayOf(start) + 7) % 7);
}

function matches(schedule: Schedule, date: LocalDate): boolean {
  if (weekdayOf(date) !== schedule.weekday) return false;
  if (schedule.cadence === 'weekly') return true;
  if (schedule.cadence === 'monthly') return date.d <= 7;
  const anchor = parseIsoDate(schedule.firstSendOn) ?? defaultAnchor(schedule.weekday);
  // An anchor on another weekday never lines up: count from the same weekday on or after it.
  const aligned = addDays(anchor, (schedule.weekday - weekdayOf(anchor) + 7) % 7);
  return (((daysBetween(aligned, date) % 14) + 14) % 14) === 0;
}

/** The next `count` slots strictly after `after`. */
export function slotsAfter(schedule: Schedule, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let date = addDays(localDate(after, schedule.timeZone), -1);
  // Monthly needs at most ~31 days per slot; this bound only stops a broken schedule from looping.
  for (let i = 0; i < 40 * count + 40 && out.length < count; i += 1) {
    if (matches(schedule, date)) {
      const at = zonedTime(date, schedule.time, schedule.timeZone);
      if (at.getTime() > after.getTime()) out.push(at);
    }
    date = addDays(date, 1);
  }
  return out;
}

/** The last slot at or before `at`, looking back at most ten weeks. */
export function latestSlotAtOrBefore(schedule: Schedule, at: Date): Date | null {
  let date = addDays(localDate(at, schedule.timeZone), 1);
  for (let i = 0; i < 72; i += 1) {
    if (matches(schedule, date)) {
      const slot = zonedTime(date, schedule.time, schedule.timeZone);
      if (slot.getTime() <= at.getTime()) return slot;
    }
    date = addDays(date, -1);
  }
  return null;
}

/**
 * The slot an email may go out in right now: the latest one at or before
 * `now`, if it is under LATE_WINDOW_MS old. Null when nothing is due.
 */
export function dueSlot(schedule: Schedule, now: Date): Date | null {
  const slot = latestSlotAtOrBefore(schedule, now);
  if (!slot) return null;
  return now.getTime() - slot.getTime() <= LATE_WINDOW_MS ? slot : null;
}

/** For saving an every-2-weeks schedule: the first date on or after `from` that falls on the weekday. */
export function nextDateOnWeekday(from: Date, weekday: number, timeZone: string): string {
  const today = localDate(from, timeZone);
  return isoDate(addDays(today, (weekday - weekdayOf(today) + 7) % 7));
}

/** "Every other Tuesday at 10:00 AM", for the page. */
export function describeSchedule(schedule: Schedule): string {
  const day = WEEKDAY_NAMES[schedule.weekday] ?? 'Tuesday';
  const time = formatClock(schedule.time);
  if (schedule.cadence === 'weekly') return `Every ${day} at ${time}`;
  if (schedule.cadence === 'monthly') return `The first ${day} of every month at ${time}`;
  return `Every other ${day} at ${time}`;
}

/** "10:00 AM" for "10:00". */
export function formatClock(time: string): string {
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  const suffix = hh < 12 ? 'AM' : 'PM';
  const hour = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/** "Tue, Nov 24, 10:00 AM PST": a slot in the schedule's own time zone, so everyone reads the same time. */
export function formatSlot(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(typeof at === 'string' ? new Date(at) : at);
}
