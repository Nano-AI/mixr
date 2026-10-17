// CONTRACT (stub). Owner: profiles subagent. Signatures are fixed; replace bodies.
import type { User } from '../types.ts';

// Braindump (everything the user said about themselves, consolidated by the agent) → canonical slot text → embedding.
// Saves name if given, sets state='active'. Returns the canonical profile text.
export async function buildProfile(userId: number, braindump: string, name?: string): Promise<string> {
  throw new Error('not implemented');
}

// Explicit edit from the user ("add bouldering", "remove tennis, hurt my wrist"). Returns the new canonical text.
export async function editProfile(userId: number, change: string): Promise<string> {
  throw new Error('not implemented');
}

// Overwrite canonical text and re-embed in one step (the text and vector never drift apart).
export async function setProfileText(userId: number, text: string): Promise<User> {
  throw new Error('not implemented');
}

// Job 'evolve_profile' {userId, eventId}: learn from a YES RSVP in text space (no-op / refine slot / append slot).
export async function evolveFromRsvp(userId: number, eventId: number): Promise<void> {
  throw new Error('not implemented');
}
