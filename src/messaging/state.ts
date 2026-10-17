import { db, tx } from '../db.ts';
import type { ChatTurn } from './agent.ts';
// Messaging-owned state keeps the shared team schema and interfaces unchanged.
db.exec(`
CREATE TABLE IF NOT EXISTS conversation_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS inbound_processing (
  provider_id TEXT PRIMARY KEY REFERENCES inbound_messages(provider_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('processing','done','failed')),
  error TEXT
);
`);
export type State = {
  consentAt?: string;
  onboarded?: boolean;
  draft?: string;
  interestNotes?: string;
  chatHistory?: ChatTurn[];
  slots?: string[];
  verification?: {
    hash: string;
    salt: string;
    expires: number;
    attempts: number;
    sent: number;
  };
};
export function getState(userId: number): State {
  const row = db
    .prepare('SELECT data FROM conversation_state WHERE user_id=?')
    .get(userId);
  return row ? JSON.parse(String(row.data)) : {};
}
export function saveState(userId: number, state: State): void {
  db.prepare(
    'INSERT INTO conversation_state(user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',
  ).run(userId, JSON.stringify(state));
}

// One-way compatibility for students paused in the former compulsory time/mode flow.
// An already-onboarded student's explicit FREE command is not a migration target.
export function moveCompletedProfilesToChat(): number {
  return tx(() => {
    const rows = db.prepare(`SELECT u.id FROM users u JOIN profiles p ON p.user_id=u.id
      WHERE u.step IN ('availability','mode') AND u.email_verified=1 AND p.confirmed=1`).all();
    let moved = 0;
    for (const row of rows) {
      const id = Number(row.id); const state = getState(id);
      if (state.onboarded) continue;
      state.onboarded = true;
      saveState(id, state);
      db.prepare("UPDATE users SET step='active' WHERE id=?").run(id);
      moved++;
    }
    return moved;
  });
}
