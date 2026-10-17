# matching/ (owner: John)

Braindump → structured profile → one vector per interest → ranked candidates. Plan tasks **T0 (schema lead), J1–J4**.

| File | Task | Exposes |
|---|---|---|
| `vectors.ts`, `embed.ts` | J1 | `cosine`, `normalize`, `mean`, `embed(texts)` |
| `profile.ts`, `extract.ts` | J2 | `buildProfile(userId, text): Promise<Profile>`, `confirmProfile(userId)` |
| `candidates.ts` | J3 | `findCandidates(c: Criteria): Candidate[]` |
| `../../scripts/seed.ts` | J4 | `npm run seed -- 1000` (synthetic users + p95 bench) |

**Boundary:** similarity ranks candidates. It does not establish availability, consent, or confirmation. Never call it a "personality compatibility" score.

**Must hold:** hard filters run before ranking. Re-running `buildProfile` replaces interests rather than appending. `LLM=fake` stays deterministic (tests and the offline demo depend on it).
