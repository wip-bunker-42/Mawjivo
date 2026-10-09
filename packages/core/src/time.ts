import { Temporal } from '@js-temporal/polyfill';
import type { ISOInstant, ScheduleResolution } from './contracts';
export function defaultSchedule(createdAt: ISOInstant): ISOInstant {
  return Temporal.Instant.from(createdAt).add({ hours: 10 }).toString();
}
export function resolveSchedule(local: string, zone: string, offset?: string): ScheduleResolution {
  try {
    const plain = Temporal.PlainDateTime.from(local);
    const fields = {
      timeZone: zone,
      year: plain.year,
      month: plain.month,
      day: plain.day,
      hour: plain.hour,
      minute: plain.minute,
      second: plain.second,
      millisecond: plain.millisecond,
    };
    const early = Temporal.ZonedDateTime.from(fields, { disambiguation: 'earlier' });
    const late = Temporal.ZonedDateTime.from(fields, { disambiguation: 'later' });
    if (!early.toPlainDateTime().equals(plain) || !late.toPlainDateTime().equals(plain))
      return {
        kind: 'invalid',
        messageAr: 'هذا الوقت غير موجود بسبب تغيير التوقيت. اختر وقتًا آخر.',
      };
    if (offset !== undefined) {
      const selected = [early, late].find((time) => time.offset === offset);
      return selected
        ? { kind: 'instant', instant: selected.toInstant().toString(), offset: selected.offset }
        : { kind: 'invalid', messageAr: 'إزاحة الوقت لا تطابق المنطقة الزمنية.' };
    }
    if (early.epochNanoseconds !== late.epochNanoseconds)
      return { kind: 'ambiguous', offsets: [early.offset, late.offset] };
    return { kind: 'instant', instant: early.toInstant().toString(), offset: early.offset };
  } catch {
    return { kind: 'invalid', messageAr: 'التاريخ أو المنطقة الزمنية غير صالح.' };
  }
}
