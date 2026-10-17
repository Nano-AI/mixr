// CONTRACT (stub). Owner: matching subagent (relay lives next to findPeople). Signatures are fixed.
import type { Intro } from '../types.ts';

// Requester said yes to a match: create the intro and text the target asking if they're open to it.
export async function requestIntro(requesterId: number, targetId: number, reason: string): Promise<Intro> {
  throw new Error('not implemented');
}

// Target answered. On accept, relay their message (and that they're happy to share their number) to the requester.
export async function respondToIntro(targetId: number, introId: number, accept: boolean, message?: string): Promise<Intro> {
  throw new Error('not implemented');
}

// Intros where this user is the target and hasn't answered yet (agent context).
export async function pendingIntrosFor(userId: number): Promise<Intro[]> {
  throw new Error('not implemented');
}
