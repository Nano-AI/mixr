# mixr (simulator build)

Text-based campus organizer: students braindump interests, get matched with people, and get invited to events other students host. This build has no SMS — a dashboard simulates phones. Design: [docs/spec.md](docs/spec.md).

## Run

```bash
npm install && (cd web && npm install)
cp .env.example .env        # add OPENAI_API_KEY
npm run seed                # 45 hand-written students; embeddings only (~3.5k tokens, cached)
npm run dev                 # server :8787 + dashboard http://localhost:5173
```

In the dashboard: open a seeded student's phone or a "New number", text the agent, use +15m/+1h/+1d to move the simulated clock (waves, timeouts, expiries fire as time passes). The inspector shows events/invites by wave, recall/rerank traces, Rocchio drift, and a 2D map.

## Credits

- `gpt-6-luna` runs only on the live path: the agent, plus pipeline steps (profile canonicalization, event HyDE, rerank, profile evolution).
- `PIPELINE_LLM=off` keeps the agent on the LLM but makes the pipeline vector-only with template copy.
- `MIXR_FAKE=1` = fully offline (fake LLM + fake embeddings). Tests always run this way: `npm test`.
- The top bar shows LLM calls and tokens used.

## Layout

`src/agent` tool-calling agent · `src/profiles` single-vector profiles · `src/matching` recall (pgvector top 40) + LLM rerank · `src/relay` double-opt-in intros · `src/events` HyDE, hidden waves, Rocchio · `src/jobs` simulated-clock jobs · `src/transport` simulated SMS (Photon adapter goes here) · `web/` dashboard.
