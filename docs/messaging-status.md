> **Historical:** predates the integration branch; see the [README](../README.md).

# Messaging status

Audited against W1–W6 in the MVP implementation plan on 2026-10-17.

| Task | Status | Remaining work |
| --- | --- | --- |
| W1: delivery, retries, dedupe | Implemented and tested | Live sustained line-capacity measurement; provider acceptance is not device delivery. |
| W2: Photon, inbound identity, local chat | Spectrum iMessage connection tested on the user's iPhone | Multi-phone live demo; Android/voice are outside the current iMessage-text scope. |
| W3: keyword routing | Implemented, including EVENTS/JOIN and WENT/MISSED | Live end-to-end meetup exercise with opted-in testers. |
| W4: onboarding | Consent, UW verification, Haiku chat, user-scoped interest tools, explicit profile review | the matching dev's buildProfile/confirmProfile are still stubs; real extraction and stored interest vectors are blocked on that dependency. Availability design is deferred by the user. |
| W5: deployment and inspection | Mac demo; authenticated admin inspection and container packaging exist | Cloud hosting deferred by user. Mac must remain awake with the process running. |
| W6: email verification | Gmail SMTP authentication verified; live database contains a verified identity | Full new-student live flow should be repeated after profile extraction lands. |

## Work completed in this pass

- Connected real feedback and public-event services to the router, with completed
  onboarding, verified-email, and opt-out checks.
- Preserved feedback notes and prevented duplicate input from consuming the next
  outstanding feedback request.
- Accepted the location suggestions already advertised in meetup invitations.
- Removed duplicate generic RSVP acknowledgements; the meetup service owns them.
- Added real-service integration tests with network delivery replaced.
- Updated help and stale documentation that described meetup modules as stubs.

## Verification from this pass

- Nine new integration tests failed before the router changes and passed after.
- After the Claude token-budget fix: full suite 110 passed, 0 failed. Type checking and
  `git diff --check` passed. Model HTTP requests are faked in automated tests.
- A live Haiku request with the user's replacement key succeeded (324 input,
  45 output tokens). The prior unscoped key required a workspace header;
  workspace discovery was denied, so the user replaced it locally.
- A handset chat exposed `max_tokens` with zero visible text. Disabled thinking
  on both requests while preserving the 256-token cap. A regression test failed
  before the fix and passed after. A live synthetic tool conversation successfully
  saved draft notes and replied (1,838 input and 112 output tokens total across
  two requests); no student records or handset messages were changed by that test.
- Independent review found no blocking defects; it also exercised RSVP location
  suggestions during an edit without changing the conversation step.
- Claude review found that PROFILE could prefer stale model notes to newer
  student corrections. Fixed with a failing-then-passing regression test;
  saved context is now provided upfront, and natural YES replies without an
  RSVP target remain conversational.
- Gmail SMTP authentication succeeded. The existing local database reports one
  verified identity, currently at the name-collection step, and no meetups.
- Restarted the Photon app with slots, planner, and scheduler available.
  `/health` reports ready; admin access returns 401 without a token and 200
  with the configured bearer token.
- Rotated the project credential after CLI project-details output unexpectedly
  included it. Updated the ignored `.env` with mode 0600; no values are recorded here.
- One earlier delivery job exhausted three attempts. Its sanitized error cannot
  identify the cause. The job is retained without resetting or replaying it;
  fresh handset delivery after the restart remains to be tested.

## Decisions carried forward

- Use Spectrum's authenticated stream rather than the plan's old webhook design;
  this matches the user's explicit Photon setup instructions.
- Remain on Free and run on the existing Mac. No subscription, hosted server, or
  automatic contact-profile work is part of this pass.
- Keep email verification mandatory; never bypass it or log codes, despite the
  original stretch-task suggestion to do so without an email provider.
- Keep changes in the current demo checkout for the running app. Matching and
  scheduling algorithms and shared contracts are unchanged. Verified students
  with confirmed profiles paused in the former compulsory time/mode step move
  back to chat; saved interests and availability are preserved.
- Do not flood the test phone to manufacture a throughput number. A sustained
  measurement needs an agreed live-test window; local test speed is not evidence.
- Claude Haiku handles basic conversation with read-own-profile/save-draft-notes
  tools. Availability is deferred; no automatic time menu follows confirmation.
  Default usage ceiling: 50 attempted requests per UTC day, max two per message,
  256 output tokens per request, thinking disabled, no automatic retries.

## Demo checks still requiring people

1. Complete onboarding on three opted-in test phones after real extraction lands.
2. Receive a proposal, accept it, verify common confirmation details, exercise a
   cancellation, and verify reminders/feedback on the phones.
3. Measure line throughput in a controlled test window, recording provider
   acceptance separately from handset delivery.

Shared-line recipients must each be registered in Photon and text the assigned
number on their own user record. Do not assume every tester uses the messaging dev's number.
