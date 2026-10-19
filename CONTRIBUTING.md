# Contributing to mixr

## Setup

Node 24 (`.nvmrc`), then:

```bash
npm install && (cd web && npm install)
cp .env.example .env
```

Set only what you need in `.env`:

| Setting | Needed for |
|---|---|
| `MIXR_FAKE=1` | Fully offline: fake LLM and embeddings, no keys at all. Good for UI and flow work. |
| `TRANSPORT=sim` | Keep this locally (`.env.example` says `photon`). Nothing is delivered; you text as anyone from the dashboard. |
| `OPENAI_API_KEY` | Embeddings: seeding, profiles, matching recall. Cached by text, so re-seeding is cheap. |
| `ANTHROPIC_API_KEY` | The agent and the matching pipeline (Claude Haiku). `PIPELINE_LLM=off` makes matching vector-only. |
| `PROJECT_ID`, `PROJECT_SECRET` | Photon iMessage (`TRANSPORT=photon`). Production only, see the slot limit below. |
| `GMAIL_USER` + `GMAIL_APP_PASSWORD` (or `RESEND_API_KEY` + `EMAIL_FROM`) | UW email codes in real onboarding. |
| `ADMIN_TOKEN` | Dashboard login. Optional locally (the dashboard is open in dev), required in production. |

## Run

```bash
npm run dev      # server http://localhost:8787 + dashboard http://localhost:5173
npm run seed     # 50 demo students (fixtures/seed-users.json); free with MIXR_FAKE=1
python3 -m http.server -d landing 4321   # landing page; ?mock=ok clicks through without a server
```

PGlite allows one process per database, so run `npm run seed` while `npm run dev` is stopped, or press **Seed** in the dashboard's top bar instead. **Reset** in the dashboard clears the demo pool only.

## Tests

```bash
npm test                       # vitest, offline: MIXR_FAKE=1 + in-memory DB (vitest.config.ts)
npm run typecheck              # server
(cd web && npx tsc --noEmit)   # dashboard
```

CI (`.github/workflows/ci.yml`) runs all of these, the dashboard build and a landing syntax check on every PR and on pushes to `main` and `integration`.

## Code map (`src/`)

- `server.ts`: entry point. Mounts the routes, starts iMessage and the background ticker.
- `runtime.ts`, `jobs/`: background work. Due jobs on each pool's clock, delivery retries, nightly DB snapshot (`backup.ts`).
- `config.ts`, `context.ts`, `clock.ts`: env; which pool (demo or real) work runs in; per-pool time.
- `agent/`: the Claude tool-calling agent (prompt, tools, conversation context).
- `db/`: PGlite + pgvector, `schema.sql`, queries, demo reset.
- `events/`: hosted events. HyDE target profile, hidden invite rounds, Rocchio drift, RSVPs.
- `http/`: routes. Public (`/join`, `/health`), admin login, dashboard API, messaging health, the built dashboard.
- `llm/`: the only Claude client (`llm()`, daily cap) and OpenAI embeddings, plus the offline fakes.
- `matching/`: pgvector recall (top 40), then Claude rerank.
- `messaging/`: iMessage over Photon Spectrum, the inbound pipeline, onboarding (consent, name, UW email code), STOP/START.
- `ops/`: operator tasks, such as resetting the real pool.
- `profiles/`: canonical profile text, edits, learning from what people say yes to.
- `relay/`: intros between two people. Numbers are shared only when both agree.
- `requirements/`: blocks and special requests, enforced before ranking.
- `transport/`: message log and the durable outbox (delivery, retries, dedupe).
- `bus.ts`, `trace.ts`, `projection.ts`: dashboard live stream, inspector traces, 2D map of profiles.

Elsewhere: `web/` dashboard (React), `landing/` joinmixr.club (static), `scripts/` seed and deploy, `deploy/` systemd units and `release.sh`, `test/`, `fixtures/`.

## Tracing a message through the application

Start here when a student texts mixr but gets no reply, a duplicate, or the wrong
onboarding prompt. This describes the current implementation; the older
`docs/messaging-operations.md` includes historical interfaces and settings.

1. **Receive and normalize:** [`src/messaging/photon.ts`](src/messaging/photon.ts)
   consumes Spectrum's authenticated event stream and accepts phone-number direct
   messages, including inline text replies. Read receipts and typing indicators
   are best-effort; their failure does not prevent processing.
2. **Identify and route:** [`src/messaging/pipeline.ts`](src/messaging/pipeline.ts)
   resolves the phone to a persistent user and serializes work per phone, while
   different phones can proceed concurrently. It records the provider ID before
   routing, so a redelivered event does not repeat onboarding or agent actions.
   STOP, START, and HELP are deterministic; opt-out and rate limits are enforced
   before ordinary conversation reaches the agent.
3. **Onboard:** [`src/messaging/onboarding.ts`](src/messaging/onboarding.ts) owns
   consent, full name, UW email, and code verification. The normal email path uses
   salted code hashes, a ten-minute expiry, and three attempts. The temporary
   judge-code path skips email verification without setting `email_verified`.
   [`email.ts`](src/messaging/email.ts) handles sending; delivery failure never
   counts as verification.
4. **Converse and act:** [`src/agent/index.ts`](src/agent/index.ts) handles texts
   after the deterministic onboarding step clears. It builds context and calls
   tools in [`src/agent/tools.ts`](src/agent/tools.ts), which connect conversation
   to profile, matching, event, and intro services. Trace tool results when a
   conversational reply succeeds but the expected action does not.
5. **Deliver:** [`src/transport/outbox.ts`](src/transport/outbox.ts) persists real
   outbound jobs with deduplication keys and claims each job atomically before
   sending. Pending jobs retry within a 24-hour window, up to three attempts.
   `sent` means Photon accepted the message, not that the handset displayed it.

On restart, interrupted inbound processing and outbound jobs left in `sending`
are marked failed for inspection, rather than automatically replayed: their
external effects may already have happened. STOP suppresses queued messages,
and START does not revive those suppressed jobs. Deduplication prevents repeated
application submissions; it is not a guarantee of exactly-once handset delivery.

For offline reproduction, use `MIXR_FAKE=1` and `TRANSPORT=sim`. Dashboard demo
users never deliver messages. Acting as a real user suppresses delivery to that
user only; other effects still run in the real pool.

## How changes ship

1. Branch off `main` and open a PR. CI must pass.
2. Merge to `main`. Within about 2 minutes polarcrest notices the new commit (`mixr-autodeploy.timer`), runs the tests, typecheck and dashboard build on the box, then switches to it and restarts. If `/health` doesn't answer within 45s it goes back to the previous release. A commit that fails any of that never goes live and isn't retried, so push a fix.
3. Vercel deploys `landing/` from `main` to joinmixr.club. Other branches, like `integration`, get a Vercel preview.

## Rules of the road

- Never commit secrets. `.env` is gitignored; production secrets live only on the server.
- Tests run offline. Never call real Claude, OpenAI or Photon from a test: use `MIXR_FAKE` and inject fetches (e.g. `setPhotonFetch`).
- Photon Free has 10 user slots. Every new number entered on the site takes one, so don't test `/join` in production with throwaway numbers.
- Demo and real pools never meet. Demo means seeded or dashboard-created users on a simulated clock, and nothing is delivered. Real means people who joined through the site, on wall-clock time, over real iMessage. Acting as a real user in the dashboard keeps mixr's replies in the dashboard, but everything else is real.
- `main` deploys itself to production. Big changes go through a PR, not a direct push.
- A rollback runs older code on the same database, so keep schema changes additive (new tables, nullable columns or columns with defaults).

## Ops cheatsheet (polarcrest)

Ask the server owner for ssh access and set `DEPLOY_HOST=user@host`.

```bash
ssh "$DEPLOY_HOST"
journalctl --user -u mixr -f                   # live app logs
journalctl --user -u mixr-autodeploy -n 50     # what auto-deploy did
systemctl --user status mixr                   # is it up
systemctl --user list-timers                   # health watchdog + auto-deploy
cat ~/mixr/BRANCH ~/mixr/REVISION              # what's live
tail ~/mixr-data/deploys.log                   # deploy history, one line per outcome
touch ~/mixr-data/autodeploy.paused            # stop auto-deploys (rm it to resume)
```

From your laptop:

```bash
scripts/deploy.sh               # deploy main now
scripts/deploy.sh <branch>      # another branch; auto-deploy leaves it up until main gets a new commit
scripts/deploy.sh --rollback    # previous release; auto-deploy waits for the next commit on main
FORCE=1 scripts/deploy.sh       # rebuild a commit that's live, or retry one that failed
```

Where things live: `~/mixr` is the live release (a symlink into `~/mixr-releases/`, 3 kept). Secrets: `~/mixr-data/mixr.env` (mode 600). Database: `~/mixr-data/pglite`. Nightly snapshots: `~/mixr-data/backups` (7 kept). Deploys never touch `~/mixr-data`.
