import { db } from '../db.ts';
import { getState, saveState } from './state.ts';
import { boundedHistory, converse, redactContactDetails, type ChatTurn } from './agent.ts';

export async function chatWithStudent(id: number, text: string, agent = converse): Promise<string> {
  const user = db.prepare('SELECT step,email_verified,opted_out FROM users WHERE id=?').get(id);
  if (!user?.email_verified || user.opted_out) throw Error('Conversation requires verified opt-in');
  const state = getState(id);
  const messages: ChatTurn[] = [...(state.chatHistory ?? []), { role: 'user', content: text }];
  const readProfile = () => {
    const row = db.prepare('SELECT data,confirmed FROM profiles WHERE user_id=?').get(id);
    const summary = row ? JSON.parse(String(row.data)).summary : '';
    return {
      notes: redactContactDetails(getState(id).interestNotes ?? '').slice(0, 2000),
      summary: redactContactDetails(String(summary ?? '')).slice(0, 2000),
      confirmed: !!row?.confirmed,
    };
  };
  try {
    const answer = await agent({
      phase: user.step === 'active' ? 'active' : 'interests',
      messages,
      profile: JSON.stringify(readProfile()),
      tools: {
        readProfile,
        saveNotes: (notes) => {
          const current = getState(id);
          current.interestNotes = notes;
          saveState(id, current);
          return { saved: true, status: 'draft; student can review with PROFILE' };
        },
      },
    });
    // Re-read after tool calls, which may have saved updated notes.
    const current = getState(id);
    current.chatHistory = boundedHistory([...messages, { role: 'assistant', content: answer }]);
    current.draft = [current.draft, redactContactDetails(text)].filter(Boolean).join('\n').slice(-10000);
    saveState(id, current);
    return answer;
  } catch {
    console.warn('Claude conversation unavailable; no automatic API retry.');
    return "I'm having trouble with chat right now. Please try again later. HELP and STOP still work.";
  }
}
