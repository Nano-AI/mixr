import type { SendResult } from '../types.ts';

// T0 stub. Wayne replaces the body in W1; the signature is the contract.
export async function sendMessage(userId: number, text: string, dedupeKey: string): Promise<SendResult> {
  console.log(`[send user=${userId} key=${dedupeKey}] ${text}`);
  return 'sent';
}
