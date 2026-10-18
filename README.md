# mixr

**A campus organizer you text.** UW students text mixr what they're into. It finds people who'd click, gets them to events other students host (inviting the right people in quiet rounds until the event fills), and learns from what people say yes to. Design: [docs/spec.md](docs/spec.md).

## How people join

1. On [joinmixr.club](https://joinmixr.club) they enter their phone number. The server registers it with Photon (iMessage shared line), which assigns them **their own mixr number**.
2. The site shows that number with a "text mixr" button. **They text first**; mixr never texts first.
3. Over iMessage: opt-in (YES) → first name → @uw.edu email → 6-digit code → then the agent takes the braindump.

Photon Free allows 10 registered users per project (Pro: 100). Every number entered on the site uses a slot.

## Architecture

One Node 24 process (the monolith) on polarcrest, embedded Postgres (PGlite + pgvector):

```
joinmixr.club (Vercel, landing/) ──POST /join──▶  mixr monolith (src/server.ts, :8787)
iPhone ◀──iMessage──▶ Photon Spectrum (gRPC) ◀──▶   ├─ messaging/   inbound pipeline, consent, UW verification, STOP/START
                                                    ├─ agent/       Claude Haiku 5.5 tool-calling agent
dashboard (admin login) ──/api──▶                   ├─ matching/    pgvector recall (top 40) + Claude rerank, hard filters
                                                    ├─ events/      HyDE, hidden invite rounds, Rocchio, RSVPs
                                                    ├─ profiles/ relay/ requirements/ (blocks, special requests)
                                                    └─ transport/   message log + outbox (delivery, retries, dedupe)
```

- **Two pools that never meet.** *Demo*: the 50 seeded students (+ numbers created in the dashboard), on a simulated clock you fast-forward; nothing is ever delivered. *Real*: people who joined through the website, on wall-clock time, delivered over iMessage.
- **Models.** Claude `claude-haiku-5-5` for the agent and the matching pipeline (daily cap `CLAUDE_DAILY_REQUEST_LIMIT`, default 1000). OpenAI `text-embedding-3-large` for embeddings only (cached by text).
- **Dashboard** at `/dashboard` (login with `ADMIN_TOKEN`): act as any user, watch the matching internals, fast-forward the demo clock. Acting as a *real* user keeps mixr's replies to them in the dashboard (nothing goes to their phone); everything else is real.

## Run locally

```bash
npm install && (cd web && npm install)
cp .env.example .env        # ANTHROPIC_API_KEY, OPENAI_API_KEY; TRANSPORT=sim keeps iMessage off
npm run seed                # 50 demo students (embeddings only, cached)
npm run dev                 # server :8787 + dashboard http://localhost:5173
npm test                    # offline: fake LLM + embeddings, in-memory DB
python3 -m http.server -d landing 4321   # landing page; add ?mock=ok to click through without a server
```

`MIXR_FAKE=1` runs fully offline. `PIPELINE_LLM=off` keeps the agent on Claude but makes matching vector-only.

## Deploy (polarcrest)

Merging to `main` deploys it. Every 2 minutes `mixr-autodeploy.timer` on polarcrest checks main for a new commit, runs the tests, typecheck and dashboard build on the box, and only then switches releases and restarts. If `/health` doesn't answer within 45s it goes back to the previous release. A failing commit never goes live. CI (`.github/workflows/ci.yml`) runs the same checks on every PR. Workflow, rules and ops cheatsheet: [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
scripts/deploy.sh               # deploy main now (also installs/updates auto-deploy)
scripts/deploy.sh integration   # another branch; auto-deploy leaves it up until main gets a new commit
scripts/deploy.sh --rollback    # previous release; auto-deploy waits for the next commit on main
FORCE=1 scripts/deploy.sh       # rebuild a live commit or retry a failed one
```

- Release logic: `deploy/release.sh` (tarball releases in `~/mixr-releases`, 3 kept; `~/mixr` points at the live one). `scripts/deploy.sh` copies it to the server and runs it; the timer runs the same script. History: `~/mixr-data/deploys.log`. Pause auto-deploy: `touch ~/mixr-data/autodeploy.paused`.
- systemd user service `mixr` (`deploy/mixr.service`): `Restart=always`, starts at boot (lingering), 4 GB cap. `mixr-health.timer` restarts it if `/health` fails twice.
- Secrets: `~/mixr-data/mixr.env` (mode 600, never in git). Data: `~/mixr-data/pglite`. Nightly snapshots: `~/mixr-data/backups` (7 kept).
- Logs: `journalctl --user -u mixr -f` (auto-deploy: `journalctl --user -u mixr-autodeploy`).
- Public URL: `https://api.joinmixr.club` (Cloudflare for SaaS custom hostname → the tunnel's `mixr-api.johnomeara.com` → `localhost:8787`; the tunnel also routes `api.joinmixr.club` itself). `mixr-api.johnomeara.com` keeps working as a direct alias.
- Railway is an option later ([docs/deploy/railway.md](docs/deploy/railway.md)); today it's the monolith.

## Privacy & consent

- Opt-in only: people join through the site and text first. No directory scraping.
- First names only in texts to others; phone numbers are shared only when both sides of an intro agree.
- `STOP` is honored immediately (and suppresses anything queued). `START` resumes.
- A verified @uw.edu email proves inbox access, not enrollment. Codes are hashed, never stored or logged.
- Blocks and special requests are enforced in code before ranking; no filtering by gender or protected traits.

## Team

See [PLAN.md](PLAN.md). Messaging layer ported from Wayne's implementation; landing page by Aditya; matching, events and the agent from John's simulator build.
