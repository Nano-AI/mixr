// Shared domain types. Every module's public interface uses these.

export type User = {
  id: number;
  phone: string;
  name: string | null;
  state: 'onboarding' | 'active';
  canonicalProfile: string | null;
  embedding: number[] | null;
  snoozedUntil: Date | null;
  seeded: boolean; // demo pool
  step: OnboardingStep | null; // real users before the agent takes over; null once verified
  email: string | null;
  emailVerified: boolean;
  optedOut: boolean;
  assignedNumber: string | null; // the Photon number this user texts mixr at
  joinedVia: string | null;
};

export type OnboardingStep = 'consent' | 'name' | 'email' | 'verify';

// A special request as data. Person rules are SQL filters before recall (stage 0); text rules are judged per
// candidate in the rerank call from what people wrote in their own profiles, and enforced by code.
// 'prefer' nudges the ordering instead of filtering.
export type Strength = 'must' | 'prefer';
export type RequirementSpec =
  | { kind: 'person'; person: string; strength: Strength; said: string } // keep this person off one event
  | { kind: 'text'; criterion: string; strength: Strength; said: string }; // e.g. "advanced tennis (4.0+)", "queer folks"
export type Requirement = RequirementSpec & { id: number; ownerId: number; eventId: number | null };

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
  requirements?: RequirementSpec[]; // stored before the first round of invites goes out
};

export type InviteStatus = 'invited' | 'yes' | 'no_busy' | 'no_vibe' | 'expired' | 'waitlisted' | 'cancelled' | 'withdrawn';
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
  forWho?: string[]; // public-safe summary of the host's text requirements; never person rules
  headsUp?: string[]; // first names of people this user blocked who are going
};

// One person going to an event (host included). Backed by the event_attendees view.
export type Attendee = { userId: number; name: string; role: 'host' | 'guest'; joinedAt: string | null; source: 'host' | 'invite' | 'discover' };

// An upcoming event the user is going to, as host or guest, with who else is going.
export type Plan = EventSummary & { role: 'host' | 'guest'; attendees: Attendee[] };

export type RecallHit = { userId: number; name: string; profile: string; similarity: number };
export type RerankPick = { userId: number; reason: string; pitch: string; checks?: { requirementId: number; verdict: 'pass' | 'fail' | 'unknown' }[] };
export type PersonMatch = { userId: number; name: string; reason: string };

export type IntroStatus = 'proposed' | 'target_asked' | 'connected' | 'declined' | 'expired';
export type Intro = { id: number; requesterId: number; targetId: number; reason: string; status: IntroStatus; targetMessage: string | null };

export type TraceKind = 'recall' | 'rerank' | 'wave' | 'rocchio' | 'profile_update' | 'agent' | 'llm' | 'embed' | 'job' | 'hyde' | 'requirement' | 'block';

// Server-sent events to the dashboard.
export type BusEvent =
  | { type: 'message'; userId: number; phone: string; direction: 'in' | 'out'; text: string; simTime: string }
  | { type: 'trace'; kind: TraceKind; refId: number | null; data: unknown; simTime: string }
  | { type: 'clock'; now: string }
  | { type: 'state' } // something in users/events/invites/intros changed; refetch
  | { type: 'reset' } // everything was wiped: close phone panes, reload
  | { type: 'resync' }; // messages changed in bulk (e.g. seeding): reload open panes
