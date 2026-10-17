# mixr Plan

The team plan for the hackathon MVP. Every task, test, and exact interface is in [`docs/superpowers/plans/2026-10-17-mixr-mvp.md`](docs/superpowers/plans/2026-10-17-mixr-mvp.md). This page is the overview.

## MVP goal

A student texts their interests, gets a compatible 1:1 or small-group proposal, accepts a time and place, and receives a confirmed meetup. No human organizer is involved.

## Spec graph

```mermaid
flowchart LR
    subgraph MSG["messaging/"]
        W1["W1 sendMessage"] --> W2["W2 Photon + server"] --> W3["W3 router"] --> W4["W4 onboarding"] --> W5["W5 deploy"]
    end
    subgraph MAT["matching/"]
        J1["J1 embeddings"] --> J2["J2 buildProfile"] --> J3["J3 findCandidates"] --> J4["J4 1k bench"]
    end
    subgraph MEET["meetups/"]
        A1["A1 createProposal"] --> A2["A2 recordResponse"] --> A3["A3 planner"] --> A4["A4 tick"] --> A5["A5 feedback + Elo"] --> A6["A6 public events"]
    end
    T0(["T0 schema + types + stubs"]) --> W1 & J1 & A1
    J2 -.-> W4
    J3 -.-> A3
    A2 -.-> W3
    W5 & J4 & A6 --> A7(["A7 E2E + demo"])
```

Solid arrows are the order within a module. Dotted arrows are cross-module dependencies. Until a real implementation lands, use the T0 stubs.

## Team & ownership

The work is split by system responsibility, so the "people" and "events" paths share components instead of becoming two products.

| Module | Owner | Folder | Tasks | Boundary |
|---|---|---|---|---|
| Contract (schema, types) | John leads, all review | `src/types.ts`, `src/db.ts`, `src/schema.sql` | T0 | Changes need all 3 to agree |
| Messaging | **Wayne** | [`src/messaging/`](src/messaging/README.md), `src/server.ts`, `scripts/chat.ts` | W1–W6 | Owns conversation and transport. Not matching or scheduling |
| Matching | **John** | [`src/matching/`](src/matching/README.md), `scripts/seed.ts` | J1–J4 | Ranks candidates. Not availability, consent, or confirmation |
| Meetups | **Aditya** | [`src/meetups/`](src/meetups/README.md), `test/e2e.test.ts` | A1–A7 | Owns event state and scheduling. Not delivery or embeddings |

## Interfaces (agree before coding)

| Function | Owner | Does |
|---|---|---|
| `buildProfile(userId, text)` | John | Structured profile for the user to confirm |
| `findCandidates(criteria)` | John | Eligible users with scores and grounded reasons |
| `createProposal(details)` | Aditya | Meetup with time, place, capacity, and deadline. Sends invites |
| `recordResponse(userId, proposalId, reply)` | Aditya | Updates participation and confirmation. Never overfills |
| `sendMessage(userId, text, dedupeKey)` | Wayne | Sends once and records the delivery outcome |

The exact types are defined in plan Task T0.

## Timeline

| Stage | Wayne | John | Aditya | Milestone |
|---|---|---|---|---|
| Hour 1 | Photon access spike | **T0** schema, types, stubs | Meetup states, invite copy | Interfaces agreed |
| First slice | W1, W2 | J1 + mock candidates | A1, A2 | Two phones complete an invite |
| Core | W3, W4 | J2, J3 | A3, A4 | Real onboarding → real proposal |
| Integration | STOP/dup tests | J4 tuning | A5, A6 | Pair + group scenarios pass |
| Final | W5 deploy | J4 bench | **A7** E2E + demo | Repeatable demo |

## Definition of done

Three or more opted-in testers can onboard, get a relevant group proposal, accept it, and receive the same confirmed details. A decline, a duplicate message, or a late acceptance never creates a wrong confirmation or overfills the event. The 1,000-profile matching benchmark is shown separately from live messaging capacity.

## Deferred

Each of these gets a GitHub issue labeled `later`, and nobody builds them until A7 passes: calendar sync, dorm/roommate matching, parties and club management, Luma hosting, voice braindumps, social-graph visualization and friend-of-friend scoring, location grouping, native group chats, the website, and LLM-written match explanations.
