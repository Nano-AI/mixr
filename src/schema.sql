CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,                       -- E.164
  name TEXT,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL DEFAULT 'new',                 -- onboarding step (messaging/onboarding.ts)
  mode TEXT NOT NULL DEFAULT 'both' CHECK (mode IN ('pair','group','both')),
  opted_out INTEGER NOT NULL DEFAULT 0,
  reliability REAL NOT NULL DEFAULT 1200,           -- Elo (meetups/feedback.ts)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  braindump TEXT NOT NULL,
  data TEXT NOT NULL,                               -- JSON Profile
  confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interests (               -- one vector per interest, not per braindump
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('does','wants_to_try')),
  level TEXT NOT NULL CHECK (level IN ('new','casual','experienced')),
  category TEXT NOT NULL CHECK (category IN ('sport','talk','other')),
  embedding BLOB NOT NULL                           -- Float32 x 384, L2-normalized
);
CREATE INDEX IF NOT EXISTS interests_user ON interests(user_id);
CREATE TABLE IF NOT EXISTS availability (
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot TEXT NOT NULL,                               -- ISO start, from meetups/slots.ts
  PRIMARY KEY (user_id, slot)
);
CREATE TABLE IF NOT EXISTS meetups (
  id INTEGER PRIMARY KEY,                           -- also the reply code: "YES 12"
  kind TEXT NOT NULL CHECK (kind IN ('pair','group')),
  activity TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('sport','talk','other')),
  place_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  min_size INTEGER NOT NULL,
  max_size INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  state TEXT NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('proposed','confirmed','expired','cancelled','done')),
  seed_embedding BLOB NOT NULL,
  embedding BLOB NOT NULL,                          -- biased toward accepted members
  host_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invitations (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','accepted','declined','cancelled','expired','full')),
  responded_at TEXT,
  place_suggestion TEXT,                            -- place id voted for via "YES 12 cafe allegro"
  PRIMARY KEY (meetup_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS inbound_messages (
  provider_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS feedback (               -- row with attended NULL = request outstanding
  meetup_id INTEGER NOT NULL REFERENCES meetups(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  attended INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meetup_id, user_id)
);
