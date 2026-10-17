import type { Profile } from '../types.ts';

// T0 stubs. John replaces the bodies in J2; the signatures are the contract.
export async function buildProfile(userId: number, text: string): Promise<Profile> {
  return { summary: text, interests: [], vibe: '', constraints: [] };
}

export function confirmProfile(userId: number): void {}
