// Display helpers for simulated time. Users live in Seattle, so everything user-facing is America/Los_Angeles.

export const TZ = 'America/Los_Angeles';

const isoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'longOffset',
});

// "2026-10-20T12:00:00-07:00": local wall time with its UTC offset.
export function laIso(d: Date): string {
  const p = Object.fromEntries(isoParts.formatToParts(d).map((x) => [x.type, x.value]));
  const off = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

const human = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// "Fri, Oct 23, 7:00 PM"
export const laHuman = (d: Date | string): string => human.format(new Date(d));

const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
// "Sat, Oct 17"
export const laDay = (d: Date | string): string => day.format(new Date(d));

const longDay = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// "Tuesday, October 20, 2026 at 12:00 PM"
export const laLong = (d: Date): string => longDay.format(d);
