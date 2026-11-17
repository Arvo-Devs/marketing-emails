// The schedule's slots: the right days, the right wall-clock time across
// daylight saving changes, every other week counted from its first date, the
// first weekday of the month, and the late window after a missed slot.
import { describe, expect, test } from 'bun:test';
import {
  describeSchedule,
  dueSlot,
  formatClock,
  LATE_WINDOW_MS,
  latestSlotAtOrBefore,
  nextDateOnWeekday,
  parseIsoDate,
  SEND_TIMES,
  slotsAfter,
  zonedTime,
  type Schedule,
} from '../src/shared/schedule';

const LA = 'America/Los_Angeles';
const tue = (cadence: Schedule['cadence'], firstSendOn: string | null = null): Schedule => ({ cadence, weekday: 2, time: '10:00', firstSendOn, timeZone: LA });
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('zonedTime', () => {
  test('10:00 in Los Angeles is 18:00 UTC in winter and 17:00 UTC in summer', () => {
    expect(zonedTime({ y: 2026, m: 11, d: 24 }, '10:00', LA).toISOString()).toBe('2026-11-24T18:00:00.000Z');
    expect(zonedTime({ y: 2026, m: 7, d: 14 }, '10:00', LA).toISOString()).toBe('2026-07-14T17:00:00.000Z');
  });

  test('the days the clocks change keep the wall-clock time', () => {
    // 2026-03-08 and 2026-11-01 are the US change days.
    expect(zonedTime({ y: 2026, m: 3, d: 8 }, '10:00', LA).toISOString()).toBe('2026-03-08T17:00:00.000Z');
    expect(zonedTime({ y: 2026, m: 11, d: 1 }, '10:00', LA).toISOString()).toBe('2026-11-01T18:00:00.000Z');
    expect(zonedTime({ y: 2026, m: 3, d: 29 }, '09:30', 'Europe/London').toISOString()).toBe('2026-03-29T08:30:00.000Z');
  });

  test('a time zone ahead of UTC lands on the right day', () => {
    expect(zonedTime({ y: 2026, m: 11, d: 24 }, '08:00', 'Asia/Tokyo').toISOString()).toBe('2026-11-23T23:00:00.000Z');
  });
});

describe('slotsAfter', () => {
  test('weekly: every Tuesday at 10:00, across the November clock change', () => {
    const slots = slotsAfter(tue('weekly'), new Date('2026-10-26T00:00:00Z'), 3);
    expect(iso(slots)).toEqual(['2026-10-27T17:00:00.000Z', '2026-11-03T18:00:00.000Z', '2026-11-10T18:00:00.000Z']);
  });

  test('strictly after: a slot at exactly `after` is not the next one', () => {
    const at = new Date('2026-11-24T18:00:00.000Z');
    expect(slotsAfter(tue('weekly'), at, 1)[0]?.toISOString()).toBe('2026-12-01T18:00:00.000Z');
  });

  test('every 2 weeks counts from firstSendOn, before and after it', () => {
    const slots = slotsAfter(tue('every_2_weeks', '2026-11-24'), new Date('2026-11-01T00:00:00Z'), 3);
    expect(iso(slots)).toEqual(['2026-11-10T18:00:00.000Z', '2026-11-24T18:00:00.000Z', '2026-12-08T18:00:00.000Z']);
  });

  test('every 2 weeks with an anchor on another weekday starts from that weekday after it', () => {
    // 2026-11-22 is a Sunday: the count starts on Tuesday 11-24.
    const slots = slotsAfter(tue('every_2_weeks', '2026-11-22'), new Date('2026-11-23T00:00:00Z'), 2);
    expect(iso(slots)).toEqual(['2026-11-24T18:00:00.000Z', '2026-12-08T18:00:00.000Z']);
  });

  test('every 2 weeks without an anchor still answers', () => {
    expect(slotsAfter(tue('every_2_weeks'), new Date('2026-11-01T00:00:00Z'), 2)).toHaveLength(2);
  });

  test('monthly: the first Tuesday of each month', () => {
    const slots = slotsAfter(tue('monthly'), new Date('2026-11-04T00:00:00Z'), 3);
    expect(iso(slots)).toEqual(['2026-12-01T18:00:00.000Z', '2027-01-05T18:00:00.000Z', '2027-02-02T18:00:00.000Z']);
  });
});

describe('latestSlotAtOrBefore and dueSlot', () => {
  test('the slot itself, at its minute', () => {
    const at = new Date('2026-11-24T18:00:00.000Z');
    expect(latestSlotAtOrBefore(tue('weekly'), at)?.toISOString()).toBe('2026-11-24T18:00:00.000Z');
  });

  test('a minute before the slot is the week before', () => {
    expect(latestSlotAtOrBefore(tue('weekly'), new Date('2026-11-24T17:59:00.000Z'))?.toISOString()).toBe('2026-11-17T18:00:00.000Z');
  });

  test('due up to six hours late, not after', () => {
    const slot = new Date('2026-11-24T18:00:00.000Z');
    expect(dueSlot(tue('weekly'), new Date(slot.getTime() + LATE_WINDOW_MS))?.toISOString()).toBe(slot.toISOString());
    expect(dueSlot(tue('weekly'), new Date(slot.getTime() + LATE_WINDOW_MS + 60_000))).toBeNull();
    expect(dueSlot(tue('weekly'), new Date(slot.getTime() - 60_000))).toBeNull();
  });

  test('monthly looks back far enough to find last month', () => {
    expect(latestSlotAtOrBefore(tue('monthly'), new Date('2026-12-31T00:00:00Z'))?.toISOString()).toBe('2026-12-01T18:00:00.000Z');
  });
});

describe('the small helpers', () => {
  test('times offered stay clear of the night hours', () => {
    expect(SEND_TIMES[0]).toBe('05:00');
    expect(SEND_TIMES.at(-1)).toBe('22:00');
    expect(SEND_TIMES).toContain('10:30');
  });

  test('words for the page', () => {
    expect(describeSchedule(tue('every_2_weeks'))).toBe('Every other Tuesday at 10:00 AM');
    expect(describeSchedule(tue('weekly'))).toBe('Every Tuesday at 10:00 AM');
    expect(describeSchedule(tue('monthly'))).toBe('The first Tuesday of every month at 10:00 AM');
    expect(formatClock('00:30')).toBe('12:30 AM');
    expect(formatClock('13:00')).toBe('1:00 PM');
  });

  test('dates', () => {
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-02-28')).toEqual({ y: 2026, m: 2, d: 28 });
    expect(nextDateOnWeekday(new Date('2026-11-23T20:00:00Z'), 2, LA)).toBe('2026-11-24');
    expect(nextDateOnWeekday(new Date('2026-11-24T20:00:00Z'), 2, LA)).toBe('2026-11-24');
  });
});
