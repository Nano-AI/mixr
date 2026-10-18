## Inspiration

Most of us have a list of things we'd do if we had someone to do them with: pickup soccer, a philosophy argument over coffee, a study partner for the same class. UW lists over a thousand student groups on HuskyLink, and the public campus calendar had 700 entries the night we pulled it. The options aren't the problem. Matching apps for students exist too. What they skip is everything after "you two should hang out": finding a time, picking a place, getting enough people to actually say yes, and dealing with whoever cancels the morning of. That logistics work is where most plans die, so that's the part we tried to automate. We put it in Messages because students answer texts and don't open new apps.

## What it does

You enter your phone number at joinmixr.club. Our server registers it with Photon, which assigns you your own mixr number, and the page hands it to you as a contact card with a Message button and Add to Contacts. On a laptop the card shows a QR code instead, since you can't text from Windows or Linux. You text first. Over iMessage, mixr asks you to opt in, asks your name and your @uw.edu email, and emails a six-digit code to prove you own that inbox (the text reminds you to check spam).

After that you're talking to an agent that texts like a classmate: lowercase, short, no customer-service voice. Tell it what you're into and it writes your profile, asking one follow-up if you mention something skill-based like tennis without a level. From there you can:

- Ask "anything going on this week?" and get mixr events plus real UW events from the campus calendar, one per line, soonest first. Say you're going and it sends a link that adds the event to Google Calendar. Links go out as their own bubble so iMessage renders a preview card.
- Ask for "pickup soccer or something." If nothing fits, mixr finds people into the same thing and offers to round them up, which makes you the host. Describe the event in plain words (what, when, where, how many) and mixr invites the right people in quiet rounds until it fills. Guests answer in natural language, and "busy friday" means something different to the matcher than "not my thing."
- Ask to meet one person. mixr asks them first and shares numbers, as contact cards, only if both of you say yes.
- Block someone, or set requirements like "advanced tennis, 4.0+." mixr enforces those before anyone gets ranked.

It also behaves like a person in the thread. When a text needs no answer, it tapbacks instead of replying. When you get a seat at an event, the confirmation comes with confetti, but only after mixr has seen that the RSVP actually went through (a yes that lands on the waitlist gets no confetti). On Android over RCS it keeps the reactions and drops the effects. Over SMS it sends plain text. STOP always works, and if someone sends more than 30 texts in an hour, mixr tells them once and goes quiet until the hour is up.

## How we built it

The backend is one Node 24 process. Hono handles HTTP, PGlite (embedded Postgres) with pgvector stores everything, and Photon's `spectrum-ts` carries iMessage over an authenticated gRPC stream. Outgoing texts go through an outbox with dedupe keys and retries, so a crash mid-send never double-texts anyone. Tests run on vitest with a fake model, fake embeddings and an in-memory database. There are 251 of them, and every push to `main` deploys only if they pass, with an automatic rollback if the health check fails.

The agent is Claude Haiku 5.5 in a bounded tool-calling loop with 17 tools (save_profile, create_event, find_people, request_intro, react, celebrate and so on). When a tool already knows exactly what to say (an RSVP went through, an intro was sent), it returns mixr's own confirmation and we send that without a second model call. That made replies faster and cut the chance of the model making something up.

Each student is one vector. Claude rewrites the braindump into a fixed "Core Interests" format and OpenAI's `text-embedding-3-large` embeds it, cached by a hash of the text so an unchanged profile is never re-billed. Finding people is three steps. Vector search and BM25 keyword search each rank the candidates, reciprocal rank fusion merges the two lists, and Claude reranks the top 40, checks skill level and writes a one-line reason grounded in the candidate's own words. Blocks and "must" requirements are filtered in SQL before any of that, and the matcher refuses filters on gender, race, religion, disability or nationality. Events borrow two more ideas from search engines, HyDE and Rocchio feedback. The math is below.

Campus events come from UW's public iCalendar feed. The server pulls it once a day, scrubs contact details out of the descriptions, and saves a dated snapshot. Searches read the newest snapshot and never hit UW live. They keep anything that's on right now or starts in the next two weeks, including all-day and multi-day events like a weekend hackathon, and rank them with the same vector plus keyword fusion.

A React + Vite dashboard at `/dashboard` lets us act as any user, fast-forward a simulated clock, read every recall, rerank and invite-round decision in a trace view, and see a 2D map of student vectors with each event's drift drawn as an arrow. Fifty invented demo students live in a separate pool that never sends a real text. We also wrote an eval harness that runs two git revisions side by side and compares retrieval quality, reply length, latency and tokens.

The landing page is static HTML, CSS and JS on Vercel. The phone is CSS 3D, and the background is a small Navier-Stokes fluid sim in WebGL2. One anime.js timeline drives the slides, and after the first message it plays on its own so people don't miss that they need to scroll.

## The math

### Similarity

Every profile is embedded and normalized to unit length, so cosine similarity is just a dot product:

$$\cos(u, v) = \frac{u \cdot v}{\lVert u \rVert \, \lVert v \rVert} = u \cdot v \qquad \text{when } \lVert u \rVert = \lVert v \rVert = 1$$

### Keyword search (BM25)

Embeddings are good at meaning and bad at exact details. To a vector, "4.5 tennis" and "tennis" look almost the same, and for a tennis player that 4.5 is the whole point. So we also score every candidate with BM25, the formula classic search engines use:

$$\text{score}(q, d) = \sum_{t \in q} \text{IDF}(t) \cdot \frac{f(t,d)\,(k_1 + 1)}{f(t,d) + k_1\left(1 - b + b\,\frac{|d|}{\text{avgdl}}\right)} \qquad \text{IDF}(t) = \ln\left(1 + \frac{N - n_t + 0.5}{n_t + 0.5}\right)$$

Here \\(f(t,d)\\) is how many times word \\(t\\) appears in profile \\(d\\), \\(|d|\\) is the profile's length, \\(N\\) is the number of candidates and \\(n_t\\) is how many of them contain \\(t\\). We use \\(k_1 = 1.2\\) and \\(b = 0.75\\). Three things fall out of it:

- Rare words count more. Among five profiles where four say "tennis" and one says "4.5", IDF(tennis) = ln(1 + 1.5/4.5) ≈ 0.29 while IDF(4.5) = ln(1 + 4.5/1.5) ≈ 1.39. The rating is worth almost five times the sport.
- Repeats level off. For an average-length profile, saying a word once gives a term weight of 2.2/2.2 = 1.0. Saying it three times gives 6.6/4.2 ≈ 1.57, not 3.
- Long profiles don't win by length. The \\(b\\) term shrinks the score of a profile longer than average, so a match in a short profile says more.

We only give the keyword boost to words that appear in at most 20% of the candidates, and never to words that frame the ask ("looking", "people", "group"), so a chatty request can't push someone up just for sharing the word "weekends."

### Fusing the two rankings

The vector score and the BM25 score live on different scales, so we merge ranks instead of scores with reciprocal rank fusion:

$$\text{RRF}(d) = \sum_{r} \frac{w_r}{60 + \pi_r(d)} \qquad w_{\text{vector}} = 1,\ \ w_{\text{keyword}} = 0.5$$

Here \\(\pi_r(d)\\) is profile d's position in ranking r (1 for the top match), and 60 is the standard damping constant. A profile that's near the top of both lists beats one that's first on only one of them. The keyword side gets half weight, so it breaks ties and rescues exact matches without overriding meaning. The top 40 after fusion go to Claude for the rerank.

### Events that learn who they're for (HyDE + Rocchio)

When someone hosts, Claude writes a profile of the ideal attendee and we embed it as the event's starting vector, \\(E_0\\). That's HyDE: searching with a made-up example of the answer instead of the question. After every RSVP we recompute the event vector with Rocchio relevance feedback, the "more like this" update from information retrieval:

$$E_t = \frac{0.70\,E_0 + 0.25\,\bar{Y} - 0.05\,\bar{N}}{\lVert 0.70\,E_0 + 0.25\,\bar{Y} - 0.05\,\bar{N} \rVert}$$

\\(\bar{Y}\\) is the average vector of everyone who said yes and \\(\bar{N}\\) is the average of everyone who said "not my thing." In other words, the event slowly becomes the average of the people actually going. "Busy friday" doesn't move it at all, since being busy says nothing about taste. The 0.70 anchor keeps the event close to what the host asked for, so three early yeses can't turn a chill board game night into something else.

### How many invites per round

Each round sends enough invites to fill the open spots at the event's own yes rate:

$$n = \min\left(10,\ \max\left(3,\ \left\lceil \frac{\text{spots left}}{p} \right\rceil\right)\right) \qquad p = \min\left(0.8,\ \max\left(0.15,\ \frac{\text{yeses}}{\text{responses}}\right)\right)$$

Until five people have responded we assume \\(p = 0.35\\), so an event with 4 open spots starts with \\(\lceil 4 / 0.35 \rceil = 12\\), capped to 10 invites. After the first round, 32 candidates come from near \\(E_t\\) and 8 from near \\(E_0\\), so the first few yeses can't pull the event into one clique. The wait between rounds is a sixth of the time left before the event, clamped between 15 minutes and 6 hours, and invites stop an hour before start.

### Campus events

UW events use the same fusion. With a request ("any hackathons?") the event embeddings are ranked against the request, BM25 ranks the titles and descriptions, and RRF merges them. Without a request, events are ranked against the student's own profile vector, so "what could I be into this week?" gets an answer about them and not just whatever is soonest.

## Challenges we ran into

Our plan assumed a Photon webhook with signed payloads. Spectrum is a gRPC stream authenticated with project credentials, so we rewrote the transport. It ended up simpler, since there's no public endpoint to protect.

Photon's plan limits shaped the product. Group threads need a dedicated iMessage line, so mixr runs each meetup as parallel 1:1 threads and acts as the go-between. We also built a version where mixr texts you first right after you sign up. In our test, Photon didn't deliver to a number that hadn't texted the line yet, so the student still sends the first text.

The agent talked too much. Early replies restated the question, apologized, and tacked an offer onto every answer. We rewrote the prompt around "answer what they asked, then stop," let tools return their own confirmations, and capped reply length. On our eval set the average reply went from 227 to 148 characters while retrieval stayed perfect (mean reciprocal rank of 1.0). Haiku also sometimes described a tool call in words instead of making it, and once returned an empty reply because thinking had eaten the whole output budget. Both got a guard and a regression test.

The campus search missed DubHacks, the event we were sitting in. The feed lists it as an all-day event that had already started, and our filters dropped both kinds before the ranking ever saw them. The embedding would have found it fine, so we fixed the filters and left the search alone.

Tapbacks and confetti started out as rules in code. They felt wrong when they fired on the wrong message, so we gave the agent `react` and `celebrate` tools and let it decide. Confetti is refused if the agent asks for it in the same step as the action, so it has to look at the result first.

Safari fought the landing page. WebKit's 3D sorting showed the screen through the back of the phone once `backdrop-filter` was involved, focusing a hidden input made iOS scroll the fixed page, and older Safari couldn't parse `color-mix()` with `calc()`. We rebuilt the page as fixed full-height slides and worked through them one by one.

## Accomplishments that we're proud of

The invite rounds never exceed capacity, keep a waitlist, treat "busy" differently from "not my thing," and stop an hour before the event, all under test. Blocks and requirements are enforced in code at the cheapest stage instead of being left to the model's judgment. The matcher can explain itself: every round, rerank and Rocchio update lands in the dashboard's trace, so we can show exactly why someone got invited. And ask mixr about hackathons this weekend and it brings up DubHacks from UW's own calendar.

## What we learned

A provider saying "accepted" doesn't mean the text was delivered, so our outbox records the first and never claims the second. A small model is easier to trust when code holds the hard rules and the model only does the parts that need judgment. And most of what makes a bot feel like a person in a group chat is restraint: shorter replies, a tapback instead of "got it!", and saying nothing when nothing needs saying.

## What's next

Run it with friends on real phones and measure what one Photon line can sustain. Add Apple Calendar links for iPhone users, and real group chats for confirmed events once we have a dedicated line.
