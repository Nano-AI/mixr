# meetups/ (owner: Aditya)

Everything after candidate selection: proposals, responses, planning, scheduling, lifecycle. Plan tasks **A1–A7**.

| File | Task | Exposes |
|---|---|---|
| `slots.ts`, `places.ts`, `proposals.ts` | A1 | `upcomingSlots`, `formatSlot`, `PLACES`, `pickPlace`, `createProposal(d, now)` |
| `responses.ts` | A2 | `recordResponse(userId, proposalId, reply, now)`, `openInvitations`, `backfill` |
| `planner.ts` | A3 | `planMeetups(now)` |
| `scheduler.ts` | A4 | `tick(now)` (expire, remind, done+feedback, plan) |
| `feedback.ts` | A5 | `recordFeedback`, `eloUpdate` |
| `events.ts` | A6 | `listPublicEvents`, `joinEvent` |
| `../../test/e2e.test.ts` | A7 | Definition-of-done acceptance test + `docs/demo.md` |

States: `proposed → confirmed → done`. `proposed → expired`. `→ cancelled`. A `confirmed` meetup that drops below min goes back to `proposed` (backfill) when more than 2h remain before the slot.

**Boundary:** you own event state and the lifecycle message text. Delivery goes through Wayne's `sendMessage`. Embeddings come from John.

**Must hold:** confirm only at `min_size` explicit accepts, never exceed `max_size`, and late or closed replies change nothing.
