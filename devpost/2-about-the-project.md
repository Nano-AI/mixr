## Inspiration

Most of us have a list of things we'd do if we had someone to do them with: pickup soccer, a philosophy argument over coffee, a study partner for the same class. Apps that match students already exist. What they skip is everything after "you two should hang out": finding a time, picking a place, getting enough people to actually say yes, and dealing with whoever cancels the morning of. That logistics work is where most plans die, so that's the part we tried to automate. We put it in iMessage because students answer texts and don't open new apps.

## What it does

You enter your phone number at joinmixr.club. Our server registers it with Photon's shared iMessage line, which assigns you your own mixr number, and the page shows it with a tap-to-text button. You text first; mixr never texts a number cold. Over iMessage it asks you to opt in, asks your name and your @uw.edu email, and emails a six-digit code to prove you have that inbox.

After that you're talking to an agent. Tell it what you're into and it writes a short profile, asking one follow-up if you mention something skill-based like tennis or climbing without a level. Ask for "pickup soccer or something" and it looks for open events; if nothing fits, it finds people into the same thing and offers to round them up, which turns you into the host. Hosts describe the event in plain words (what, when, where, how many) and mixr invites the right people in quiet rounds until it fills. Guests answer in natural language: "busy friday" and "not my thing" mean different things to the matcher. You can also ask to meet one person; mixr asks them first and only shares numbers if both of you agree. You can block someone or set requirements like "advanced tennis, 4.0+", and mixr enforces them before anyone gets ranked.

## How we built it

One Node 24 process: Hono for HTTP, PGlite (embedded Postgres) with pgvector for storage, Photon's `spectrum-ts` for iMessage over an authenticated gRPC stream, and an outbox with dedupe keys and retries. Tests run on vitest with a fake LLM, fake embeddings and an in-memory database: 184 of them.

Each student is one vector: Claude rewrites the braindump into a fixed "Core Interests" format, and OpenAI's `text-embedding-3-large` embeds it (cached by a hash of the text, so unchanged profiles are never re-billed). Matching is two stages. pgvector recalls the top 40 by cosine, then Claude Haiku 5.5 reranks them, enforces skill level and writes a one-line pitch grounded in the candidate's own profile. Blocks and "must" requirements are filtered in SQL before recall, and the matcher refuses gender filters or anything on race, religion, disability or nationality.

Events borrow two ideas from search engines, HyDE and Rocchio feedback (the math is below). Every LLM step has a non-LLM fallback, and Claude has a persistent daily request cap.

A React + Vite dashboard at `/dashboard` (admin login) lets us act as any user, fast-forward a simulated clock, read every recall/rerank/round decision in a trace view, and see a 2D map of student vectors with each event's drift drawn as an arrow. Fifty hand-written demo students live in a separate pool that never sends a real text. The server runs under systemd with a health watchdog and nightly database snapshots, behind a Cloudflare tunnel.

The landing page (`landing/`) is static HTML, CSS and JS on Vercel. The phone is CSS 3D, and its edge is 15 stacked rounded slices. The background (`landing/glow.js`) is a small Navier-Stokes fluid sim in WebGL2 that pushes color out to the screen edges when you swipe up on the lock screen. anime.js v4 runs one timeline split into six slides (hero, notification, Messages opening, two chat beats, number pad) that you move through with the scroll wheel, swipes, taps or arrow keys.

## The math

Every profile is embedded as a 1536-dimension vector and normalized to unit length, so cosine similarity is just a dot product:

$$\cos(u, v) = \frac{u \cdot v}{\lVert u \rVert \, \lVert v \rVert} = u \cdot v \qquad \text{when } \lVert u \rVert = \lVert v \rVert = 1$$

pgvector uses that to recall the 40 closest students, then Claude reranks them.

When someone hosts, Claude writes a profile of the ideal attendee and we embed it as the event's starting vector, E0 (that's HyDE). After every RSVP we recompute the event vector with Rocchio relevance feedback, the classic "more like this" update from information retrieval:

$$E_t = \frac{0.70\,E_0 + 0.25\,\bar{Y} - 0.05\,\bar{N}}{\lVert 0.70\,E_0 + 0.25\,\bar{Y} - 0.05\,\bar{N} \rVert}$$

Y-bar is the mean vector of everyone who said yes and N-bar is the mean of everyone who said "not my thing". "Busy friday" doesn't move the vector at all, since being busy says nothing about taste. The 0.70 anchor keeps the event close to what the host asked for.

Each invite round sends enough invites to fill the open spots at the event's own yes rate:

$$n = \min\left(10,\ \max\left(3,\ \left\lceil \frac{\text{spots left}}{p} \right\rceil\right)\right) \qquad p = \min\left(0.8,\ \max\left(0.15,\ \frac{\text{yeses}}{\text{responses}}\right)\right)$$

Until five people have responded we assume p = 0.35. After the first round, 32 candidates come from near Et and 8 from near E0, so the first few yeses can't pull the event into one clique. The wait between rounds is a sixth of the time left before the event, between 15 minutes and 6 hours.

## Challenges we ran into

Our plan assumed a Photon webhook with signed payloads. Spectrum 12 is a gRPC stream authenticated with project credentials, so we rewrote the transport. It ended up simpler, since there's no public endpoint to protect.

Photon's plan limits shaped the product. Group threads need a dedicated iMessage line, which is a Business plan feature, and on the shared line every student has to be registered and text their own assigned number. So mixr runs each meetup as parallel 1:1 threads and acts as the go-between. Photon also has no inference API, so the model calls go to Anthropic with our own key.

On a real phone, Haiku sometimes returned a reply that hit `max_tokens` with no visible text. Thinking was eating the whole output budget. We turned thinking off for these calls and added a regression test.

The landing page started as a scroll-driven page, and on phones the sticky section jumped and zoomed. We rebuilt it as fixed full-height slides. Then Safari: WebKit's 3D sorting showed the screen through the back of the phone once `backdrop-filter` was involved (fixed with `backface-visibility`), focusing the hidden number input made iOS scroll the fixed page, older Safari couldn't parse `color-mix()` with `calc()`, and `click` events there don't carry `pointerType`.

## Accomplishments that we're proud of

The invite rounds never exceed capacity, keep a waitlist, treat "busy" differently from "not my thing", and stop an hour before the event, all under test. Blocks are enforced in code at the cheapest stage instead of being left to the model's judgment. And the matcher can explain itself: every round, rerank and Rocchio update lands in the dashboard's trace, so we can show exactly why someone got invited. The Photon connection carried real conversations on an iPhone, verification email and all.

## What we learned

A provider saying "accepted" doesn't mean the text was delivered, so our outbox records the first and never claims the second. A small model is easier to trust when code holds the hard rules: blocks and requirements are filtered in SQL before Claude ever sees a candidate, and every model step has a plain fallback if the call fails.

## What's next

Run it with a few friends on real phones, measure what one Photon line can sustain, and move to a Photon plan with room for more than the free tier's 10 registered students.
