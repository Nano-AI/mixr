import type { Meetup, ProposalDetails } from '../types.ts';

// T0 stub. Replaced in A1; the signature is the contract.
export async function createProposal(d: ProposalDetails, now = new Date()): Promise<Meetup> {
  throw new Error('createProposal: not implemented (A1)');
}
