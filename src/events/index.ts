// CONTRACT (stub). Owner: events subagent. Signatures are fixed; replace bodies.
import type { EventRow, EventSummary, NewEvent, RsvpResponse, RsvpResult } from '../types.ts';

// HyDE → E0 = Et → save → schedule wave 1 now (+ close_event at startsAt).
export async function createEvent(hostId: number, d: NewEvent): Promise<EventRow> {
  throw new Error('not implemented');
}

// Guest replies to an invite. 'cancel' releases an accepted seat.
export async function respondToInvite(userId: number, eventId: number, response: RsvpResponse): Promise<RsvpResult> {
  throw new Error('not implemented');
}

export type ManageAction = 'status' | 'add_spots' | 'cancel' | 'stop_inviting';
// Host controls. Returns a short plain-text status for the agent to relay. Never mentions waves.
export async function manageEvent(hostId: number, eventId: number, action: ManageAction, n?: number): Promise<string> {
  throw new Error('not implemented');
}

// Pull path: open events with spots, ranked for this user (optionally by a free-text query). Up to 3.
export async function discoverEvents(userId: number, query?: string): Promise<EventSummary[]> {
  throw new Error('not implemented');
}

// Agent context helpers.
export async function openInvitesFor(userId: number): Promise<(EventSummary & { inviteStatus: string })[]> {
  throw new Error('not implemented');
}
export async function hostedEventsFor(userId: number): Promise<(EventSummary & { status: string })[]> {
  throw new Error('not implemented');
}

// Join an event the user found via discover (creates the invite row, then accepts).
export async function joinEvent(userId: number, eventId: number): Promise<RsvpResult> {
  throw new Error('not implemented');
}
