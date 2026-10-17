# messaging/ (owner: Wayne)

Everything between the student's phone and the app. Plan tasks **W1–W6**.

| File | Task | Exposes |
|---|---|---|
| `send.ts`, `transport.ts` | W1 | `sendMessage(userId, text, dedupeKey): Promise<SendResult>`, `retryFailed()` |
| `photon.ts` (+ `../server.ts`, `../../scripts/chat.ts`) | W2 | `connectPhoton`, `parseSpectrumMessage`; authenticated stream, not a webhook |
| `router.ts` | W3 | `handleInbound(m: Inbound)` |
| `onboarding.ts` | W4 | `onboardingStep(userId, text)` |

**Boundary:** you own conversation flow and transport. Call John's `buildProfile`/`confirmProfile` and Aditya's `recordResponse`/`openInvitations`/`planMeetups`. Don't implement matching or scheduling here.

**Must hold:** duplicate webhooks are processed once. Bare `YES` with 2+ open invites asks which one. `STOP` silences everything, except the one STOP acknowledgement.

The router also handles `EVENTS`, `JOIN <id>`, `WENT`/`MISSED` plus notes, and
`YES <id> + <place>`. Meetup services send their own lifecycle acknowledgements;
do not add a second generic response. See [current status](../../docs/wayne-status.md).
