# Additional info

## Title track

Cook Smarter

## Sponsored side tracks

Photon

Optional second sponsored track: SideShift "Best Startup Idea". Open to any stack, judged in person on the startup concept; only enter if someone can pitch distribution.

## Non-sponsored side tracks

(suggestions; you decide)

- MLH Best Domain Name from GoDaddy Registry: joinmixr.club is a `.club` domain, a GoDaddy Registry TLD, registered with the free MLH code through Porkbun. Costs nothing to enter.
- DubHacks NEXT: fits "real problem with a clear user"; the weak spot is a revenue story.
- MLH DEV Writing Challenge: $100 for a post on DEV. Only if someone will write it tonight.

Skipped: Gemini, MongoDB, Tiger Data, Solana, Backboard (not used), Vultr (not hosted there), Freshman (only if the whole team is freshmen), Commit Fellowship (only if you plan to keep going as a startup).

## Discord usernames

`<fill in>`, `<fill in>`, `<fill in>`

## Universities

University of Washington

## GoDaddy Registry domains

joinmixr.club

## Tech feedback

(Photon / Spectrum)

Spectrum's gRPC event stream was the best surprise. We'd planned around a signed webhook, and the stream meant no public endpoint, no tunnel and no signature checks; we just iterate app.messages and send through im.space.create(user).send(text). Read receipts and typing indicators made the agent feel native, and we wrap both so a failure never blocks a reply. The rough spots: the beta API reference is marked as still being written, and the SDK's published type declarations have errors, so we run tsc with skipLibCheck like Photon's template does. Getting an SMS number asks for a card even with hackathon credits. Group threads need a dedicated line, which is Business-only, so our agent runs every meetup as parallel 1:1 threads. On the shared line each user has to be registered and text their assigned number first (we tried having mixr text new sign-ups first, and it didn't deliver), and the free shared line reported imessageSynced=false, so mixr's contact name and photo didn't show for testers. The CLI's avatar upload calls Bun.file and fails under Node, and its project-details output printed our project secret, which we then rotated. There's no inference endpoint, so we bring our own model key. Clearer docs on plan limits (shared-user caps, what each plan can send first) would have saved us the most time.

## Which AI tools did you use?

Select Anthropic and OpenAI.

Anthropic and OpenAI. We built mixr with Claude Code. At runtime, mixr calls Claude Haiku 5.5 through the Anthropic API for the texting agent and the matching steps (profile rewriting, ideal-attendee profiles, reranking), and OpenAI's text-embedding-3-large for embeddings.

## Did you implement a generative AI model?

We use two hosted models; we didn't train or fine-tune anything. Claude Haiku 5.5 (Anthropic API) runs the texting agent, a bounded tool-calling loop with 17 tools such as save_profile, create_event, respond_to_invite, request_intro, and react and celebrate (the agent decides on tapbacks and confetti itself), and four matching steps: rewriting a braindump into a fixed profile format, writing an "ideal attendee" profile for each event (HyDE), reranking the top 40 matches (vector search fused with BM25 keyword search) with a one-line pitch, and deciding whether an RSVP should refine a profile. OpenAI's text-embedding-3-large turns profiles, and UW calendar events, into vectors stored in pgvector. Every pipeline step has a non-LLM fallback, blocks and hard requirements are enforced in SQL before the model sees candidates, and a persistent daily cap limits Claude requests. Tests run fully offline with a fake model and fake embeddings.

## Gemini project number

N/A
