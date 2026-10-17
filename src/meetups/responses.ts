import type { Reply, ResponseResult } from '../types.ts';

// T0 stubs. Replaced in A2; the signatures are the contract.
export async function recordResponse(userId: number, proposalId: number, reply: Reply, now = new Date()): Promise<ResponseResult> {
  return { outcome: 'not_invited' };
}

// Meetup ids the user can answer: `pending` invitations for yes/pass, `accepted` for cancel.
export function openInvitations(userId: number, reply: Reply): number[] {
  return [];
}
