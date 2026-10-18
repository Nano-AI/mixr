CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  state TEXT NOT NULL DEFAULT 'onboarding' CHECK (state IN ('onboarding', 'active')),
  canonical_profile TEXT,             -- source of truth for who the user is
  embedding vector(1536),             -- derived from canonical_profile, always re-embedded together
  snoozed_until TIMESTAMPTZ,
  seeded BOOLEAN NOT NULL DEFAULT false,  -- true = demo pool (seeded or created in the dashboard)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Real users (joined through the website + iMessage). Onboarding before the agent takes over:
--   step: 'consent' -> 'name' -> 'email' -> 'verify' -> NULL (verified; the agent handles the braindump)
ALTER TABLE users ADD COLUMN IF NOT EXISTS step TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photon_user_id TEXT;      -- Photon shared-line user id
ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_number TEXT;     -- the number this user texts mixr at
ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_via TEXT;          -- 'web' | 'imessage' | 'demo'
-- The service their texts arrive on (Photon's sender.service on the last inbound); NULL = unknown. Picks what
-- rich content deliver() sends (src/messaging/photon.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS service TEXT CHECK (service IN ('imessage', 'rcs', 'sms'));
-- One verified UW email per person (the onboarding code claims it atomically; this is the backstop).
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email ON users(lower(email)) WHERE email_verified;

-- Pending UW email codes (salted scrypt hash, never the code itself).
CREATE TABLE IF NOT EXISTS email_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  sim_time TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);
-- 'phone' | 'dashboard' for inbound (who typed it); 'system' for outbound.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'phone';

-- Outbound delivery to real users over Photon. 'sent' = provider accepted, not handset delivery.
CREATE TABLE IF NOT EXISTS message_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message_id INTEGER REFERENCES messages(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  even_if_opted_out BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- Native iMessage extras for one job (contact card, effect, tapback, ...; RichContent in src/transport/outbox.ts).
-- NULL = plain text. `text` stays the plain fallback, sent if Photon rejects the rich form.
ALTER TABLE message_jobs ADD COLUMN IF NOT EXISTS content JSONB;

-- Databases created before 'sending' existed.
ALTER TABLE message_jobs DROP CONSTRAINT IF EXISTS message_jobs_status_check;
ALTER TABLE message_jobs ADD CONSTRAINT message_jobs_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed'));

-- Inbound iMessages, persisted by provider id before processing: duplicates are processed once, and a crash
-- mid-processing leaves a 'processing' row to inspect rather than blindly replaying side effects.
CREATE TABLE IF NOT EXISTS inbound_messages (
  provider_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done', 'failed')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  raw_description TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  location TEXT NOT NULL,
  capacity INTEGER NOT NULL,          -- guest spots, host excluded
  hyde_profile TEXT NOT NULL,         -- synthetic "ideal attendee" profile text
  initial_embedding vector(1536) NOT NULL,  -- E0, never changes
  current_embedding vector(1536) NOT NULL,  -- Et, recomputed after every RSVP
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'full', 'closed', 'cancelled')),
  wave_number INTEGER NOT NULL DEFAULT 0,   -- internal only, never shown to users
  next_wave_at TIMESTAMPTZ,
  thin_pool_notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL
);

-- Imported events (UW campus calendar): the feed's UID, so re-importing never duplicates. NULL = made in mixr.
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_uid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_source_uid ON events(source_uid) WHERE source_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_invites (
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  wave INTEGER NOT NULL,
  pitch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'yes', 'no_busy', 'no_vibe', 'expired', 'waitlisted', 'cancelled', 'withdrawn')),
  invited_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'invite' CHECK (source IN ('invite', 'discover')),  -- how they got on the list
  PRIMARY KEY (event_id, user_id)
);
-- Databases created before `source` / 'withdrawn' existed.
ALTER TABLE event_invites ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'invite';
ALTER TABLE event_invites DROP CONSTRAINT IF EXISTS event_invites_status_check;
ALTER TABLE event_invites ADD CONSTRAINT event_invites_status_check
  CHECK (status IN ('invited', 'yes', 'no_busy', 'no_vibe', 'expired', 'waitlisted', 'cancelled', 'withdrawn'));

-- Who is going to each event: the host plus every guest whose RSVP is 'yes'. Derived from events + event_invites
-- (the stored source of truth), so it can never disagree with seat counting.
CREATE OR REPLACE VIEW event_attendees AS
  SELECT e.id AS event_id, e.host_id AS user_id, 'host' AS role, e.created_at AS joined_at, 'host' AS source
  FROM events e
  UNION ALL
  SELECT i.event_id, i.user_id, 'guest' AS role, i.responded_at AS joined_at, i.source
  FROM event_invites i
  WHERE i.status = 'yes';

-- Blocks: someone a user doesn't want around. Name as the blocker gave it ("nate sullivan"; "nate" = every Nate),
-- which also covers someone who joins later. Effects (src/requirements):
--   - the blocked person is never invited to (or shown) events the blocker hosts, and vice versa
--   - people-matching never pairs them, in either direction; no intros
--   - if they end up at the same event anyway, the blocker gets a heads-up
--   - the blocked person is never told
CREATE TABLE IF NOT EXISTS blocks (
  id SERIAL PRIMARY KEY,
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  name_pattern TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL
);

-- Blocks resolved to the users they currently match (whole-word name prefix, never the blocker).
CREATE OR REPLACE VIEW block_matches AS
  SELECT b.id AS block_id, b.blocker_id, u.id AS blocked_id
  FROM blocks b
  JOIN users u ON b.active AND u.id <> b.blocker_id AND u.name IS NOT NULL
   AND (lower(u.name) = b.name_pattern OR lower(u.name) LIKE b.name_pattern || ' %');

-- Special requests as data ("keep sam off this one", "advanced players only", "queer folks if possible"). Enforced by
-- code at the cheapest reliable stage, never left to the reranker's discretion: person rules are SQL filters before
-- recall; text rules are judged per candidate from what people wrote in their own profiles, and code drops the fails.
--   event_id set  = this event's invites (person or text)
--   event_id NULL = standing preference for this user's people-matching (text only; use blocks for people)
CREATE TABLE IF NOT EXISTS requirements (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'text')),
  person_pattern TEXT,                -- kind person: lowercased name as given
  criterion TEXT,                     -- kind text: who qualifies, judged from profiles
  strength TEXT NOT NULL CHECK (strength IN ('must', 'prefer')),
  said TEXT NOT NULL,                 -- the user's words; private to the owner and the inspector
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (kind <> 'person' OR event_id IS NOT NULL)
);

-- Person rules resolved to the users they currently match.
CREATE OR REPLACE VIEW person_rule_matches AS
  SELECT r.id AS requirement_id, r.owner_id, r.event_id, r.strength, u.id AS user_id
  FROM requirements r
  JOIN users u ON r.kind = 'person' AND r.active AND u.id <> r.owner_id AND u.name IS NOT NULL
   AND (lower(u.name) = r.person_pattern OR lower(u.name) LIKE r.person_pattern || ' %');

-- Verdicts from the rerank-stage judge on text rules, so later rounds don't re-check (or re-invite) people.
CREATE TABLE IF NOT EXISTS screenings (
  context TEXT NOT NULL,              -- 'event:12' or 'people:7'
  user_id INTEGER NOT NULL REFERENCES users(id),
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'unknown')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (context, user_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS intros (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id),
  target_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'target_asked', 'connected', 'declined', 'expired')),
  target_message TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  run_at TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(done, run_at);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pool TEXT NOT NULL DEFAULT 'demo';  -- runs on that pool's clock

CREATE TABLE IF NOT EXISTS traces (
  id SERIAL PRIMARY KEY,
  sim_time TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  data JSONB NOT NULL
);
ALTER TABLE traces ADD COLUMN IF NOT EXISTS pool TEXT NOT NULL DEFAULT 'demo';

CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  now TIMESTAMPTZ NOT NULL
);

-- Attempted Claude requests per UTC day (the CLAUDE_DAILY_REQUEST_LIMIT cap).
CREATE TABLE IF NOT EXISTS llm_budget (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0
);

-- Real embeddings are cached by text so re-seeding and re-embedding unchanged text costs nothing.
CREATE TABLE IF NOT EXISTS embedding_cache (
  key TEXT PRIMARY KEY,
  embedding vector(1536) NOT NULL
);
