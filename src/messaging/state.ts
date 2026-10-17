import { db } from '../db.ts';
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
