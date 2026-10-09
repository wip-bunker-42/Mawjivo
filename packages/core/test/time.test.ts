import { expect, test } from 'vitest';
import { defaultSchedule, resolveSchedule } from '../src/time';
test('plus_ten_hours_crosses_date_from_instant', () => {
  const createdAt = '2026-10-09T20:00:00Z';
  expect(defaultSchedule(createdAt)).toBe('2026-10-10T06:00:00Z');
  expect(Date.parse(defaultSchedule(createdAt)) - Date.parse(createdAt)).toBe(36_000_000);
});
test('cairo_dst_gap_rejected_and_overlap_requires_offset', () => {
  expect(resolveSchedule('2026-04-24T00:30', 'Africa/Cairo').kind).toBe('invalid');
  const repeated = resolveSchedule('2026-10-29T23:30', 'Africa/Cairo');
  expect(repeated).toEqual({ kind: 'ambiguous', offsets: ['+03:00', '+02:00'] });
  expect(resolveSchedule('2026-10-29T23:30', 'Africa/Cairo', '+02:00')).toEqual({
    kind: 'instant',
    instant: '2026-10-29T21:30:00Z',
    offset: '+02:00',
  });
});
test('invalid_zone_or_wrong_offset_does_not_guess_a_time', () => {
  expect(resolveSchedule('2026-10-09T20:00', 'Invalid/Zone').kind).toBe('invalid');
  expect(resolveSchedule('2026-10-29T23:30', 'Africa/Cairo', '+01:00').kind).toBe('invalid');
});
