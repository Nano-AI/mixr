CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  state TEXT NOT NULL DEFAULT 'onboarding' CHECK (state IN ('onboarding', 'active')),
  canonical_profile TEXT,             -- source of truth for who the user is
  embedding vector(1536),             -- derived from canonical_profile, always re-embedded together
  snoozed_until TIMESTAMPTZ,
  seeded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  sim_time TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);

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

CREATE TABLE IF NOT EXISTS event_invites (
  event_id INTEGER NOT NULL REFERENCES events(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  wave INTEGER NOT NULL,
  pitch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'yes', 'no_busy', 'no_vibe', 'expired', 'waitlisted', 'cancelled')),
  invited_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'invite' CHECK (source IN ('invite', 'discover')),  -- how they got on the list
  PRIMARY KEY (event_id, user_id)
);
-- Databases created before `source` existed.
ALTER TABLE event_invites ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'invite';

-- Who is going to each event: the host plus every guest whose RSVP is 'yes'. Derived from events + event_invites
-- (the stored source of truth), so it can never disagree with seat counting.
CREATE OR REPLACE VIEW event_attendees AS
  SELECT e.id AS event_id, e.host_id AS user_id, 'host' AS role, e.created_at AS joined_at, 'host' AS source
  FROM events e
  UNION ALL
  SELECT i.event_id, i.user_id, 'guest' AS role, i.responded_at AS joined_at, i.source
  FROM event_invites i
  WHERE i.status = 'yes';

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

CREATE TABLE IF NOT EXISTS traces (
  id SERIAL PRIMARY KEY,
  sim_time TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  now TIMESTAMPTZ NOT NULL
);

-- Real embeddings are cached by text so re-seeding and re-embedding unchanged text costs nothing.
CREATE TABLE IF NOT EXISTS embedding_cache (
  key TEXT PRIMARY KEY,
  embedding vector(1536) NOT NULL
);
