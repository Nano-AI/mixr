// Shared domain types. Every module's public interface uses these.

export type User = {
  id: number;
  phone: string;
  name: string | null;
  state: 'onboarding' | 'active';
  canonicalProfile: string | null;
  embedding: number[] | null;
  snoozedUntil: Date | null;
  seeded: boolean;
};

export type EventStatus = 'open' | 'full' | 'closed' | 'cancelled';

export type EventRow = {
  id: number;
  hostId: number;
  title: string;
  rawDescription: string;
  startsAt: Date;
  location: string;
  capacity: number;
  hydeProfile: string;
  status: EventStatus;
  waveNumber: number;
  nextWaveAt: Date | null;
};

export type NewEvent = {
  title: string;
  description: string;
  startsAt: Date;
  location: string;
  capacity: number;
};

export type InviteStatus = 'invited' | 'yes' | 'no_busy' | 'no_vibe' | 'expired' | 'waitlisted' | 'cancelled';
export type RsvpResponse = 'yes' | 'no_busy' | 'no_vibe' | 'cancel';
export type RsvpResult = { outcome: 'accepted' | 'waitlisted' | 'declined' | 'cancelled' | 'closed' | 'not_invited'; detail: string };

// What a user can see about an event (agent context, discover results).
export type EventSummary = {
  id: number;
  title: string;
  description: string;
  startsAt: string; // ISO
  location: string;
  spotsLeft: number;
  goingCount: number;
  hostName: string;
  fit?: number; // discover only: cosine of the event to what they asked for (or their profile), 3dp
};

// One person going to an event (host included). Backed by the event_attendees view.
export type Attendee = { userId: number; name: string; role: 'host' | 'guest'; joinedAt: string | null; source: 'host' | 'invite' | 'discover' };

// An upcoming event the user is going to, as host or guest, with who else is going.
export type Plan = EventSummary & { role: 'host' | 'guest'; attendees: Attendee[] };

export type RecallHit = { userId: number; name: string; profile: string; similarity: number };
export type RerankPick = { userId: number; reason: string; pitch: string };
export type PersonMatch = { userId: number; name: string; reason: string };

export type IntroStatus = 'proposed' | 'target_asked' | 'connected' | 'declined' | 'expired';
export type Intro = { id: number; requesterId: number; targetId: number; reason: string; status: IntroStatus; targetMessage: string | null };

export type TraceKind = 'recall' | 'rerank' | 'wave' | 'rocchio' | 'profile_update' | 'agent' | 'llm' | 'embed' | 'job' | 'hyde';

// Server-sent events to the dashboard.
export type BusEvent =
  | { type: 'message'; userId: number; phone: string; direction: 'in' | 'out'; text: string; simTime: string }
  | { type: 'trace'; kind: TraceKind; refId: number | null; data: unknown; simTime: string }
  | { type: 'clock'; now: string }
  | { type: 'state' }; // something in users/events/invites/intros changed; refetch
