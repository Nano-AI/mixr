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

Ask John for ssh access (`jsomeara@polarcrest.johnomeara.com`).

```bash
ssh jsomeara@polarcrest.johnomeara.com
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
