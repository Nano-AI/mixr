# mixr — design spec (simulator build)

A campus organizer you text. Users braindump interests, get a profile, get matched with people, and get invited to events other students host. This build has **no SMS**: a React dashboard simulates many phone numbers talking to the agent, and an inspector shows the hidden algorithm.

## Hard rules

- **LLM credits are scarce.** `gpt-6-luna` is only called from the live product path (the agent, plus pipeline steps: canonicalize, HyDE, rerank, evolve). Never from tests, seed scripts, or dev tooling. Tests run with `MIXR_FAKE=1` (fake LLM + fake embeddings). Seed data is hand-written; seeding only calls the embeddings API (cached in `embedding_cache`).
- Every pipeline LLM step checks `pipelineLlm(name)` first and has a **non-LLM fallback** (so `PIPELINE_LLM=off` or the fake LLM still works end to end).
- **Waves are invisible to users.** No user-facing text ever says "wave", "vector", "score", "algorithm".
- Users see **first names only**. Phone numbers are shared only when both sides of an intro accept.
- All time comes from the simulated clock (`src/clock.ts`), never `Date.now()`. Timezone for display: `America/Los_Angeles`.
- Stack: Node 24 + TypeScript (run with `tsx`), PGlite + pgvector, Hono, OpenAI SDK (Responses API — function tools on gpt-6-luna require it), React + Vite. Imports use `.ts` extensions. Tunable constants live at the top of the file that uses them with a `// tune:` comment.

## Architecture

```
web/ (React dashboard) ──HTTP + SSE──▶ src/server.ts (Hono, one process)
  transport/  simulated inbox/outbox (Photon adapter later)
  agent/      one tool-calling GPT agent per inbound text
  profiles/   canonicalize braindump, edit, evolve from RSVPs
  matching/   recall (pgvector top 40) + LLM rerank, findPeople
  relay/      double-opt-in intros (1:1 agent relay)
  events/     HyDE, hidden waves, Rocchio, RSVPs, discover
  jobs/       simulated-clock job runner
  db/         PGlite schema; trace.ts feeds the inspector
```

Foundation (done, shared, don't change without coordination): `config.ts`, `types.ts`, `db/`, `clock.ts`, `bus.ts`, `trace.ts`, `vec.ts`, `llm/index.ts`, `llm/embed.ts`, `transport/`, `jobs/`. Module contracts are the stub signatures in each module's `index.ts`.

## Single vector per user

- `users.canonical_profile` is the source of truth; `users.embedding` is always `embed(canonical_profile)`, written together by `setProfileText`.
- Canonical format, equal-weight slots with noun-rich "subspace expansion" for skill:
  ```
  Core Interests:
  [1] Competitive tennis, varsity match play, USTA 4.5, high-pace hitting partner, tournament sets (Level: Advanced).
  [2] Tabletop board games, strategy games, Settlers of Catan, Wingspan, social game nights (Vibe: Casual).
  ```
  2–6 slots, ~10–15 words each, no filler, no slang, no first person.
- Retrieval is always two-stage: **recall** top 40 by cosine (cheap, tolerant of a polymath's diluted vector), then **rerank** with the LLM (reads text, enforces skill level, writes the pitch).

## Profiles (`src/profiles/`)

- `buildProfile(userId, braindump, name?)`: LLM `canonicalize_profile` → `{profile_text}`. Fallback: `"Core Interests:\n[1] " + braindump`. Sets name, `state='active'`, re-embeds, traces `profile_update`.
- `editProfile(userId, change)`: LLM `edit_profile` → `{profile_text}` (add/remove/modify slots). Fallback: append a slot.
- `evolveFromRsvp(userId, eventId)` (job `evolve_profile`): LLM `evolve_profile` → `{action: 'no_update'|'refine'|'append', profile_text, note}` given current profile, the event, and the user's past YES events. Rules: topic already covered → no_update (prevents frequent board-game nights diluting jazz); event reveals skill/context → refine that slot; genuinely new interest → append an equal-weight slot. Fallback: no-op. Trace before/after.

## Blocks and special requests (`src/requirements/`)

Anything about who should or shouldn't be included is data, enforced by code at the cheapest reliable stage of the funnel. Never left to the reranker's discretion, never written into an event description.

**Blocks** (`blocks`, resolved by the `block_matches` view; whole-word name prefix, so "nate" = every Nate but not Nathan, and it covers people who join later):
- The blocked person is never invited to, or shown in discover, events the blocker hosts, and vice versa (stage 0, SQL, before recall).
- People-matching never pairs them, either direction; intros are refused.
- Someone else's event keeps nobody out: whoever blocked the other gets a heads-up instead, whether they join after the blocked person (`heads up` appended to their confirmation, flagged in discover results and agent context) or the blocked person joins after them (a text).
- Blocking withdraws now-forbidden pending invites silently; the blocked person is never told.

**Special requests** (`requirements`): `kind person` (keep someone off one event) or `kind text` (who qualifies, e.g. "advanced tennis, 4.0+", "queer folks"), each `must` or `prefer`, scoped to an event or standing (people-matching, text only).
- Person rules: SQL filter before recall (`prefer` = ranked lower).
- Text rules: the rerank call returns a verdict per candidate per rule (pass/fail/unknown, judged only from what people wrote in their own profiles, never inferred). Code keeps only explicit passes on `must`, orders by `prefer` passes, and stores verdicts in `screenings` so later rounds skip the fails. No judge available + a `must` text rule = nobody qualifies (fail closed). Self-serve joins are judged once too.
- Policy: no gender filters, nothing on race, religion, disability or nationality (validated in code and stated in both prompts). Identity/community (e.g. queer) counts only when people volunteer it; onboarding never asks.
- Agent tools: `block_person`, `unblock_person`, `add_requirement`, `remove_requirement`, and `create_event.requirements`. Guests only ever see text rules ("for: advanced tennis, 4.0+").

## Matching (`src/matching/`, `src/relay/`)

- `recall(vector, {exclude, limit=40})`: `state='active' AND embedding IS NOT NULL AND (snoozed_until IS NULL OR snoozed_until <= clock)`, `ORDER BY embedding <=> v`. `similarity = 1 - distance`. Trace `recall` (top hits, no vectors).
- `rerank({purpose, target, candidates, k})`: LLM `rerank` → `{picks: [{user_id, reason, pitch}]}`; ignore unknown/duplicate ids, cap at k, may return fewer. Pitch is one friendly sentence grounded in the candidate's profile ("thought of you since you play 4.5 and love doubles"). Fallback: top k by similarity, template pitch from their first slot. Trace `rerank` with picks and reasons.
- `findPeople(userId, request?, k=3)`: query vector = `embed("Looking for: " + request)` if request else the user's embedding; recall excludes self and anyone already in an intro with them; rerank `purpose:'people'`.
- Relay (Photon is 1:1 only, so the agent is the bridge):
  - `requestIntro` → intro `target_asked`, text the target: "hey {target}! {requester} on campus is looking for {reason}. want me to connect you two?" Schedule `expire_intro` +24h.
  - `respondToIntro(accept, message)` → `connected`: text requester "{target} is down! they said: "{message}". their number: {phone}" and text target the requester's number. Decline → `declined`, tell requester gently. Expiry → `expired`, tell requester.

## Events (`src/events/`) — hidden waves + Rocchio

- `createEvent(host, d)`: LLM `hyde_profile` → `{target_profile}` written in the canonical slot format ("ideal attendee"). Fallback: `"Target Attendee:\n[1] {title}. {description}"`. `E0 = Et = embed(target_profile)`. Schedule job `wave {eventId, afterWave: 0}` now and `close_event` at `startsAt`. Trace `hyde`.
- **Wave job** `{eventId, afterWave}` — runs only if `event.wave_number === afterWave` and status `open` (dedupes early triggers):
  1. Stop if `now >= startsAt − CUTOFF (1h)`.
  2. Expire earlier waves' still-`invited` rows (`expired`, neutral — no penalty).
  3. `spotsLeft = capacity − yes`. If ≤ 0 → `full`, stop.
  4. `pYes` = this event's yes / (resolved + expired) once ≥ 5 resolved, else `0.35`; clamp to [0.15, 0.8]. `n = clamp(ceil(spotsLeft / pYes), 3, 10)`.
  5. Candidates = `recall(Et, 32) ∪ recall(E0, 8)` (exploration buffer so the first RSVPs' clique doesn't lock the event in; wave 1 is just `recall(E0, 40)`), excluding host and everyone already invited.
  6. `rerank({purpose:'event', target: title + description + hyde_profile, k: n})`.
  7. No picks → if not yet notified, tell host "found {going} so far — the pool for this is pretty thin right now, i'll keep an eye out" (`thin_pool_notified`), stop.
  8. Insert invites (`wave = wave_number + 1`), text each: "{pitch} {title} — {when} at {location}. {spotsLeft} spot(s) left, you down?" Increment `wave_number`.
  9. `next_wave_at = now + clamp((startsAt − now) / 6, 15 min, 6 h)`; schedule `wave {eventId, afterWave: new wave_number}` then. Trace `wave` {wave, n, pYes, spotsLeft, invited: [{userId, name, pitch, source: 'Et'|'E0'}]}.
- **Early next wave:** after any RSVP, if no `invited` rows remain, spots are left and status is `open`, schedule the next wave job now.
- `respondToInvite(user, event, response)`:
  - no invite → `not_invited`; event not open/full or started → `closed`.
  - `yes`: if full → `waitlisted` ("just filled up, i'll keep you in mind"). Else `yes`; text host "{first} is in for {title} ({going}/{capacity})"; if now full → status `full`, text host "you're full!". Recompute Rocchio. Schedule `evolve_profile` now. Result `detail` includes location/time so the agent can confirm.
  - `no_busy` (schedule conflict): no penalty. `no_vibe` (not interested): recompute Rocchio with the negative term.
  - `cancel` (from yes): `cancelled`; text host; if event was `full` → `open` and schedule a wave now.
- **Rocchio** (recomputed from scratch after each RSVP, anchored to E0): `Et = normalize(0.70·E0 + 0.25·mean(U_yes) − 0.05·mean(U_no_vibe))`, dropping empty terms. Trace `rocchio` {yes, noVibe, cosToE0}.
- `close_event` job: open/full → `closed`; remaining `invited` → `expired`.
- `manageEvent(host, event, action, n)`: `status` → "Catan night: 2/3 going (Jordan, Taylor). still finding people." · `add_spots n` → capacity += n, reopen if full, wave now · `cancel` → `cancelled`, text yes-guests · `stop_inviting` → capacity = going, status `full`. Never mentions waves.
- `discoverEvents(user, query?)`: open, future, spots left, not hosted by user; rank by `cosine(Et, query ? embed(query) : user.embedding)`; top 3, each with `fit` (that cosine). Nearest isn't relevant, so the agent judges relevance from title/description. `joinEvent` inserts an invite (`source = 'discover'`) then accepts.
- **Attendance:** `event_invites` is the stored record (`status = 'yes'` = going, `source` = invite or discover). The `event_attendees` view = host + yes guests, and `attendeesFor(event)` / `plansFor(user)` read it. Cancelling flips the row to `cancelled` (kept as history). `/api/state` events carry `attendees`; the agent context lists the user's plans with who's going (first names).

## Agent (`src/agent/`)

- `handleInbound(phone, text)`: `getOrCreateUser`, `recordInbound`, run the loop, `send` the final text. Per-phone serialization (promise chain) so two texts from one phone don't race. After the turn, `runDue()`.
- Input: last 20 messages (in → `user`, out → `assistant`), then a `developer` context block **last** (stable instructions + history prefix gets prompt-cached): sim time (LA), whether this is their first text ever, user name/state/profile/snooze, invites waiting on their answer, their plans with who's going, intros awaiting their answer, events they host, recently shown people/events.
- Loop: up to 6 Responses calls; execute function calls, feed back `function_call_output` (JSON), stop when no calls. Trace `agent` per turn (tools called + args + results).
- Tools (strict JSON schema; optional args are nullable):
  `save_profile {name|null, braindump}` · `edit_profile {change}` · `create_event {title, description, starts_at (ISO w/ offset), location, capacity}` · `respond_to_invite {event_id, response: yes|no_busy|no_vibe|cancel}` · `manage_event {event_id, action, n|null}` · `discover_events {query|null}` · `join_event {event_id}` · `find_people {request|null}` · `request_intro {target_user_id, reason}` · `respond_to_intro {intro_id, accept, message|null}` · `snooze {until|null}`.
- Behavior: every reply moves things forward (no dead-end "what's up?"). A first text from someone with an existing profile gets a welcome that names a few of their interests and asks what to add. Vague asks ("pickup soccer or something") → `discover_events`; if nothing genuinely matches → `find_people` for that activity → offer to round people up (becomes `create_event` with them as host). Onboarding = get name + braindump; if a skill-gated activity (sports, climbing, running, chess, competitive games, instruments) lacks a level, ask **one** casual follow-up; then `save_profile`. Event creation needs what/when/where/how many; ask once for anything missing. Invite replies are natural language: "busy friday" → `no_busy`, "not my thing" → `no_vibe`; ask when ambiguous between two open invites. Find people: present matches, then `request_intro` for the one(s) they pick. SMS style: short, warm, casual, no markdown.

## Server API (`src/server.ts`, port 8787)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/state` | | `{ now, users[], events[], intros[], usage }` (see below) |
| GET | `/api/messages/:phone` | | `[{direction, text, simTime}]` |
| POST | `/api/inbound` | `{phone, text}` | `{ok}` after the agent replies |
| POST | `/api/clock/advance` | `{minutes}` | `{now, jobsRan}` |
| GET | `/api/traces` | `?limit=300&kind=` | `[{id, simTime, kind, refId, data}]` newest first |
| GET | `/api/projection` | | `{points: [{id, label, kind: 'user'|'event0'|'eventT', eventId?, x, y}]}` |
| GET | `/api/stream` | | SSE, each `data:` is a `BusEvent` JSON |
| POST | `/api/reset` | | wipe all but embedding cache |
| POST | `/api/seed` | | load `fixtures/seed-users.json` (embeddings only) |

`/api/state`: `users: [{id, phone, name, state, profile, snoozedUntil, seeded}]`; `events: [{id, hostId, hostName, title, description, startsAt, location, capacity, status, waveNumber, nextWaveAt, hydeProfile, going, cosToE0, invites: [{userId, name, wave, status, pitch, invitedAt, respondedAt}]}]`; `intros: [{id, requesterName, targetName, reason, status}]`; `usage: {llmCalls, byPurpose: {name: count}, inputTokens, outputTokens, embedTokens}` (from `llm`/`embed` traces).

## Dashboard (`web/`)

Top bar: sim clock, +15m / +1h / +6h / +1d, Seed, Reset, LLM call counter. Left: phone panes (open a seeded user or a new random number; up to 4 visible; bubbles, input, typing indicator while the POST is pending). Right inspector tabs: **Events** (status, roster, invites grouped by wave with status chips and pitches, Et drift), **Users** (profiles), **Trace** (live feed, filter by kind, readable rendering of recall/rerank/wave/rocchio, raw JSON on expand), **Map** (2D PCA of user vectors with each event's E0 → Et arrow). SSE drives live updates.

## Seed data

`fixtures/seed-users.json`: 50 hand-written UW students `{name, phone, profile, onboardedDaysAgo, history}`; `history` is the hand-written onboarding conversation that produced the profile (inserted into `messages` only if the user has none). Profiles are in canonical format, clustered with overlaps (tennis at several levels, climbing, board games, hardware/maker, indie music, jazz, cooking, running, chess, Valorant/Smash, photography, hiking, anime, startups…) plus polymaths. Phones `+12065550101…`. Written by a human/Claude, never generated with gpt-6-luna.

## Testing

`vitest` with `MIXR_FAKE=1`, in-memory PGlite. Unit tests per module with hand vectors (`test/helpers.ts`: `fresh`, `makeUser`, `axis`) and FakeLlm handlers. Key cases: wave sizing and stop conditions, exploration union, capacity never exceeded, waitlist, busy vs vibe penalty, Rocchio anchored to E0, evolve no-op/refine/append, relay lifecycle, recall excludes snoozed/onboarding users, agent tool loop with a scripted fake.
