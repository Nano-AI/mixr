> **Historical:** predates the integration branch; see the [README](../README.md).

# Messaging operations

Mixr's application entry point is `npm start`. `npm run spectrum` is the original
standalone echo demonstration; never run both against the same Photon project.
The application uses the authenticated Spectrum gRPC stream, not a public
webhook. No inbound Photon HTTP endpoint or tunnel is required.

## Configuration

Use Node 24+, `npm ci`, and an ignored `.env`. On the messaging dev's development machine:

```sh
PATH="$HOME/.local/node_modules/.bin:$PATH" npm start
```

Required for Photon: `PROJECT_ID`, `PROJECT_SECRET`, `TRANSPORT=photon`.
For Gmail verification: `EMAIL_PROVIDER=gmail`, `GMAIL_USER`, and
`GMAIL_APP_PASSWORD`. Create a dedicated mailbox, enable Google 2-Step
Verification, and generate an app password named Mixr. Store that app password
in the ignored `.env`, never in chat or Git. Gmail sends over TLS on port 465.
The normal Google account password is not used.

Alternatively, Resend requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and
`EMAIL_FROM` (a verified domain sender).
Email verification fails closed when configuration or delivery is unavailable;
codes are never logged. Codes expire in ten minutes, allow three attempts, and
are stored as salted scrypt hashes. A verified email cannot be linked to a
second messaging identity. Verification proves inbox access, not enrollment.

Use `DB_PATH` for a persistent SQLite file, `ADMIN_TOKEN` for inspection,
`PORT` (default 3000), and `HOST` (localhost by default). Use `HOST=0.0.0.0`
inside a container. Production requires an admin token and database path.
Store secrets in the host's secret manager; never bake `.env` into an image.

## Claude conversation

Set `ANTHROPIC_API_KEY` in the ignored `.env`. The default model is
`claude-haiku-5-5` (`ANTHROPIC_MODEL`). Keys that are not workspace-scoped also
need `ANTHROPIC_WORKSPACE_ID`; the app sends it as `anthropic-workspace-id`.
The official `@anthropic-ai/sdk` makes requests directly to Anthropic.

The default `CLAUDE_DAILY_REQUEST_LIMIT=50` is a hard, persistent cap on attempted
requests per UTC day. It counts failed requests and tool follow-ups; restarting
the process does not reset it. Set it to 0 to disable API requests. Each inbound
chat message makes at most two requests, each capped at 256 output tokens with
low effort, thinking disabled, a 15-second timeout, and automatic retries disabled.
Disabling thinking leaves the short output budget available for tool arguments
and visible replies instead of exhausting it before producing text. Context is
limited to eight turns (1,200 characters each) plus bounded profile context.
This caps request counts, not dollar spending; a provider-side spending limit
can additionally bound the API account. Tests use `LLM=fake` or fake HTTP responses.

After deterministic consent/name/email verification, Mixr chats naturally about
interests. Claude can call only `get_my_profile` and `save_interest_notes`:
both are bound to the current verified student by application code, and neither
can select a different user, RSVP, change consent, or schedule a meetup. Draft
notes survive restarts and are provided as context for later messages. Known
email/phone/code patterns are redacted from model input; early verification
messages never go through Claude. This is not general-purpose PII detection.

`PROFILE` explicitly reviews the conversation through the matching dev's extraction
interface. `OK` confirms it and returns to chat. Newer student statements are
retained even if the model did not call its notes tool. Availability collection
is deferred: there is no automatic time menu after confirmation. The existing
`FREE` command remains available only when explicitly requested. Scheduling and
matching algorithms remain owned by the teammate modules.
On startup, verified students with confirmed profiles paused at the old compulsory
availability/mode step resume chat. Existing availability is preserved; an
already-onboarded student's explicit FREE flow is left intact.

`HELP`, `STOP`, verification, and explicit RSVP commands do not spend Claude
tokens. A bare YES with a pending invitation still routes to RSVP; an ordinary
affirmative with no invitation remains conversational. Model failures yield a
bounded retry-later message while deterministic commands continue working.

## Team interfaces

- Person 2: `buildProfile(userId, text)` and `confirmProfile(userId)` in
  `src/matching/profile.ts`. Messaging appends corrections to the original
  braindump and calls extraction again. The profile module still has stubs;
  real interests and embeddings depend on Person 2's implementation.
- Person 3: `recordResponse` and `openInvitations` in `src/meetups/responses.ts`.
  The lifecycle implementation is present. Messaging routes replies without
  implementing scheduling or seat allocation. Lifecycle services own RSVP
  acknowledgements; the router adds only the missing-invitation response.
- Person 3 sends invitations, confirmations, and reminders through
  `sendMessage(userId, text, dedupeKey)`. Use a stable key for each logical
  notification, e.g. `invite:12:7` or `reminder:12:7:one-hour`.
- `meetups/slots.ts`, `planner.ts`, and `scheduler.ts` are present; startup
  reports their availability. Restart after changing these modules to load
  `upcomingSlots`, `planMeetups`, and `tick`. Without the slot
  module, students can supply explicit future ISO start times with timezone
  offsets. Messaging does not generate proposals itself.
- `recordFeedback` records WENT/MISSED and owns the thank-you response.
  `listPublicEvents` sends the EVENTS menu with the inbound reply dedupe key;
  `joinEvent` handles JOIN and owns lifecycle responses. These commands require
  completed onboarding and a verified email, including during profile edits.

## Consent and conversation

New phone identities receive an explicit opt-in prompt before name, email,
verification code, and natural interest conversation. Profile review is explicit;
availability and mode are no longer compulsory onboarding questions.
`YES` at consent or summary confirmation belongs to onboarding. Once active,
`YES`, `PASS`, and `CANCEL` target invitations. Bare replies with multiple
invitations ask for a numbered choice. `STOP`, `STOPALL`, `UNSUBSCRIBE`, `END`,
and `QUIT` suppress subsequent deliveries, cancel accepted invitations and
pass pending ones through Person 3's API. `START` resumes messaging.
`EDIT`, `FREE`, and `HELP` support profile/availability maintenance.
`EVENTS` lists public meetups; `JOIN <id>` requests a seat. `WENT` or `MISSED`,
optionally followed by a note, answers the newest outstanding feedback request.
`YES <id> + <place>` passes a suggested location to the meetup service.

Only phone-number direct messages are accepted. Group conversations and
email-based iMessage identities are ignored to avoid publishing onboarding
information in a group or incorrectly merging identities.

## Delivery and recovery

`message_jobs` records provider acceptance (`sent`), not handset delivery.
Dedupe keys prevent duplicate application submissions. Failures are retained
with a sanitized error and retried every minute, up to three total attempts.
STOP suppresses pending retries except STOP acknowledgements. An ambiguous
network failure or process crash after acceptance can still cause a duplicate
on retry; end-to-end exactly-once delivery is not promised.

Inbound provider IDs are persisted before routing. Processing is serialized.
Duplicates do not advance onboarding or repeat workflow calls. Failed or
interrupted processing is recorded in `inbound_processing`; it is not blindly
replayed because external side effects may already have happened. Inspect the
state and ask the student to repeat the intended action if appropriate.

`GET /health` returns 200 once startup is ready, 503 otherwise.
`GET /admin/messages` returns the last 100 delivery records, excluding text.
`GET /admin/inbound` lists failed/interrupted input processing. Both require
`Authorization: Bearer <ADMIN_TOKEN>`; tokens in query strings are rejected.
Keep administrative endpoints behind HTTPS and restricted network access.

## Container deployment

```sh
docker build -t mixr:local .
docker run --name mixr --restart unless-stopped --env-file .env \
  -e NODE_ENV=production -e DB_PATH=/data/mixr.db -e HOST=0.0.0.0 \
  -p 127.0.0.1:3000:3000 -v mixr-data:/data mixr:local
```

Use exactly one application replica with a persistent volume mounted at `/data`.
The image runs as an unprivileged user; the mounted directory must be writable
by uid 1000. A hosting platform should run the same image, inject secrets, mount
the volume, and use `/health` for checks. Back up the SQLite database using its
backup mechanism or with the process stopped, not by copying an active DB file.
Shutdown handles SIGINT/SIGTERM. Never deploy a second consumer while the local
Photon process remains active. Cloud deployment requires a chosen host/account.

## Validation

`npm test` covers outbox dedupe/retry/opt-out, onboarding, verification failures,
summary corrections, availability selection, ambiguous routing, inbound
validation, and admin access. `npm run typecheck` checks application code;
`skipLibCheck` works around errors in the SDK's shipped declaration bundle.
`test/messaging/workflows.test.ts` exercises the actual meetup services through
the router and durable outbox, with only network delivery replaced. It covers
feedback, public events, joins, location suggestions, consent gating, and
duplicate input. Real profile extraction still depends on the matching dev's implementation.
Live multi-phone confirmation/reminders and sustained Photon capacity remain
unverified; unit-test throughput is not a measurement of line capacity.
Cloud deployment is deferred by the user; the demo runs on the Mac.

## iMessage personalization

Mixr marks accepted inbound direct messages as read and shows typing while the
conversation handler runs. Typing is cleared even when processing fails.
Indicator failures are best-effort and do not block the reply. Duplicate input
and messages from opted-out users do not trigger indicators (START can resume).

Outbound jobs can carry native iMessage content (`message_jobs.content`, `RichContent`
in `src/transport/outbox.ts`); `text` is always stored as the log line and the plain
fallback. If building or sending the rich form throws, Photon rejects it, or the kind is
unsupported, the deliverer logs a warning and sends `text` instead, so everything
degrades to plain texts. Used today:

- mixr's contact card (name, `landing/brand/mixr-contact.jpg`, the user's assigned
  number) right after verification, once per user; skipped without an assigned number;
- the other person's contact card (first + last name, phone) on both sides of an accepted intro,
  its caption sent as a plain bubble first;
- confetti when the agent's `celebrate` tool asks for it (a seat they just got, finishing
  signup, an intro that went through): it rides on that turn's text, at most one per turn;
- a joinmixr.club link preview after the HELP text;
- tapbacks: the agent's `react` tool (❤️ 👍 😂 ‼️) tapbacks the text it is answering,
  alone instead of a filler reply, or before a short reply when the text has an emotional
  beat; at most one per turn; the fallback is the bare emoji;
- inline replies: a student's inline reply to an older message (e.g. an invite) is now
  accepted as text, and mixr's plain answers during that turn thread under it.

### iMessage, RCS and SMS

Android students text the same line over RCS or SMS. Every inbound text carries the
service Apple reports for the sender (spectrum `message.sender.service`: `iMessage`,
`RCS`, `SMS` or `unknown`, from advanced-imessage `Message.sender.service`, proto
`ChatServiceType` 1/2/3). It is stored on `users.service` (`imessage|rcs|sms`, NULL =
unknown) before and after each inbound text is handled; `unknown` never overwrites a
known value. `deliver()` picks the content per stored service, and the agent sees it on
the user line of its context block as `service=imessage|rcs|sms|unknown`.

| kind | imessage / unknown | rcs | sms |
| --- | --- | --- | --- |
| reaction | tapback (fallback: the emoji) | tapback (fallback: nothing) | nothing |
| effect | text with confetti | text | text |
| contact | caption, then the vCard | text (it carries the number) | text |
| share_contact | Share Name and Photo | skipped | skipped |
| reply | threaded under their text | plain text | plain text |
| richlink | link preview | text + URL | text + URL |

Unknown keeps the old behavior (try the rich form, fall back to text on error). iOS 18
RCS carries emoji reactions to Android; screen effects and Share Name and Photo are
iMessage-only. Still to confirm on a real Android phone: an RCS tapback from Photon shows
as a reaction (not a "Loved ..." text), the inbound `service` reads `RCS` for an RCS
chat and `SMS` with RCS turned off.

The Photon project profile is named Mixr with its previously generated avatar uploaded.
The current Free shared line reports `imessageSynced=false`, so the SDK's automatic
name/photo sharing is not active.

Right after UW email verification mixr also sends `nativeContactCard()` (Apple's
"Share Name and Photo") once per user, best effort: errors are logged and swallowed,
nothing replaces it, and it is not written to the chat log. **Risk:** it always shares
the *sending account's* own card. On the Free shared line that account is Photon's
shared number, so the recipient may be offered Photon's (or another tenant's) name and
photo instead of mixr's. Check it on a real iPhone; if it shows the wrong identity, set
`IMESSAGE_SHARE_CARD=off` (default on) and restart. The vCard contact card below is
unaffected. `assets/mixr-contact.vcf` is a saveable contact
card with the avatar and the current test user's assigned number, +16287896827.
Do not reuse that number for other shared-line users without checking their
own `assignedPhoneNumber` records. Photon CLI 2.2.0's avatar upload command
requires the Bun runtime because it calls `Bun.file` even under Node.
