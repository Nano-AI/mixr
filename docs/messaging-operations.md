# Messaging operations

Mixr's application entry point is `npm start`. `npm run spectrum` is the original
standalone echo demonstration; never run both against the same Photon project.
The application uses the authenticated Spectrum gRPC stream, not a public
webhook. No inbound Photon HTTP endpoint or tunnel is required.

## Configuration

Use Node 24+, `npm ci`, and an ignored `.env`. On Wayne's development machine:

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

## Team interfaces

- Person 2: `buildProfile(userId, text)` and `confirmProfile(userId)` in
  `src/matching/profile.ts`. Messaging appends corrections to the original
  braindump and calls extraction again. The current checkout still has stubs;
  real interests and embeddings depend on Person 2's implementation.
- Person 3: `recordResponse` and `openInvitations` in `src/meetups/responses.ts`.
  Those are also still stubs. Messaging routes replies without implementing
  scheduling or seat allocation.
- Person 3 sends invitations, confirmations, and reminders through
  `sendMessage(userId, text, dedupeKey)`. Use a stable key for each logical
  notification, e.g. `invite:12:7` or `reminder:12:7:one-hour`.
- When `meetups/slots.ts`, `planner.ts`, and `scheduler.ts` exist, restart the
  application to load `upcomingSlots`, `planMeetups`, and `tick`. The current
  checkout lacks them; startup prints their availability. Without the slot
  module, students can supply explicit future ISO start times with timezone
  offsets. Messaging does not generate proposals itself.

## Consent and conversation

New phone identities receive an explicit opt-in prompt before name, email,
verification code, interests, confirmation, availability, and pair/group mode.
`YES` at consent or summary confirmation belongs to onboarding. Once active,
`YES`, `PASS`, and `CANCEL` target invitations. Bare replies with multiple
invitations ask for a numbered choice. `STOP`, `STOPALL`, `UNSUBSCRIBE`, `END`,
and `QUIT` suppress subsequent deliveries, cancel accepted invitations and
pass pending ones through Person 3's API. `START` resumes messaging.
`EDIT`, `FREE`, and `HELP` support profile/availability maintenance.

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
Live UW mail, Person 2 extraction, Person 3 scheduling, and the cloud deployment
must be verified separately once their dependencies are available.

## iMessage personalization

Mixr marks accepted inbound direct messages as read and shows typing while the
conversation handler runs. Typing is cleared even when processing fails.
Indicator failures are best-effort and do not block the reply. Duplicate input
and messages from opted-out users do not trigger indicators (START can resume).

The Photon project profile is named Mixr with `assets/mixr-avatar.png` uploaded.
The current Free shared line reports `imessageSynced=false`; native name/photo
sharing is therefore not active. `assets/mixr-contact.vcf` is a saveable contact
card with the avatar and the current test user's assigned number, +16287896827.
Do not reuse that number for other shared-line users without checking their
own `assignedPhoneNumber` records. Photon CLI 2.2.0's avatar upload command
requires the Bun runtime because it calls `Bun.file` even under Node.
