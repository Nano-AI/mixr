// All user-facing event copy lives here: short casual SMS, first names only.
// Never say "wave", "vector", "score", or "algorithm" in anything below.

const TZ = 'America/Los_Angeles';

const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const dayDateTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// "Fri 7:00 PM"; adds the date when the event is a week or more out so the weekday isn't ambiguous.
export function fmtWhen(t: Date, now?: Date): string {
  if (now && t.getTime() - now.getTime() >= 6 * 24 * 3600_000) return dayDateTime.format(t);
  return dayTime.format(t);
}

export const firstName = (name: string | null | undefined): string => (name ?? '').trim().split(/\s+/)[0] || 'someone';

const spots = (n: number) => `${n} spot${n === 1 ? '' : 's'}`;

export type EventCopy = { title: string; when: string; location: string };

export const inviteText = (pitch: string, e: EventCopy, spotsLeft: number): string =>
  `${pitch.trim()} ${e.title} — ${e.when} at ${e.location}. ${spots(spotsLeft)} left, you down?`.replace(/\s+/g, ' ');

export const hostGuestIn = (guest: string, title: string, going: number, capacity: number, full: boolean): string =>
  `${guest} is in for ${title} (${going}/${capacity})${full ? ". you're full!" : ''}`;

export const hostGuestOut = (guest: string, title: string, going: number, capacity: number): string =>
  `heads up, ${guest} can't make ${title} anymore (${going}/${capacity}). i'll find someone to fill the spot`;

export const hostThinPool = (going: number): string =>
  `found ${going} so far — the pool for this is pretty thin right now, i'll keep an eye out`;

export const guestAccepted = (e: EventCopy, host: string): string =>
  `you're in for ${e.title}! ${e.when} at ${e.location}. ${host} is hosting`;

// A fresh "you're in" (not "already in"): the agent's confirmation of it goes out with confetti.
export const isFreshAccept = (detail: string): boolean => detail.startsWith("you're in for ");

export const guestAlreadyIn = (e: EventCopy): string => `you're already in for ${e.title} — ${e.when} at ${e.location}`;

export const guestWaitlisted = (title: string): string => `${title} just filled up, i'll keep you in mind if a spot opens`;

export const guestDeclined = (title: string): string => `no worries, i'll let ${title} go`;

export const guestCancelled = (title: string): string => `got it, you're off the list for ${title}`;

export const guestClosed = (title: string): string => `${title} isn't taking rsvps anymore`;

export const guestSpotOpened = (e: EventCopy): string =>
  `good news — a spot opened up for ${e.title} (${e.when} at ${e.location}). still down?`;

export const guestEventCancelled = (host: string, e: EventCopy): string =>
  `heads up: ${host} cancelled ${e.title} (${e.when}). sorry!`;

// Appended to a confirmation when people this user blocked are going. Empty when there's nobody.
export const headsUp = (names: string[]): string =>
  names.length ? ` heads up: ${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} going too.` : '';

// Self-serve join refused because the host asked for something specific (text rules only; safe to say).
export const guestNotForYou = (title: string, criterion: string): string =>
  `the host set ${title} up for ${criterion}, so i can't add you to that one. want me to look for something similar?`;
