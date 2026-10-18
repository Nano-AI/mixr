// System prompts and strict JSON schemas for the profile pipeline steps.

const FORMAT_RULES = `Canonical profile format (follow exactly):
Core Interests:
[1] <slot text> (Level: <Beginner|Intermediate|Advanced>).
[2] <slot text> (Vibe: <Casual|Social|Chill|Focused|Competitive|Creative|...>).

Rules:
- The first line is exactly "Core Interests:". Then 2 to 6 numbered slots, one per line, numbered [1], [2], ... with no gaps.
- One slot per distinct interest. Every slot carries equal weight: roughly 10 to 15 words each, never one long slot and several stubs. Merge near-duplicates (e.g. "bouldering" and "rock climbing" are one slot); split unrelated things.
- Each slot is a dense, noun-rich phrase list separated by commas: the activity, its common synonyms, specific sub-genres, named examples, formats, and settings. Write it so a stranger with the same interest would use the same words.
- Subspace expansion for skill-gated activities (sports, climbing, running, chess, instruments, competitive games): translate the self-described level into the jargon that people at that level actually use, and end the slot with (Level: X).
  * Advanced tennis -> "Competitive tennis, varsity match play, USTA 4.5, tournament sets, high-pace hitting partner (Level: Advanced)."
  * Beginner tennis -> "Recreational tennis, learning fundamentals, casual rally, beginner clinic, relaxed practice hitting (Level: Beginner)."
  * Intermediate climbing -> "Indoor bouldering, V3-V5 problems, top rope, gym sessions, improving technique (Level: Intermediate)."
  * Advanced chess -> "Competitive chess, 1800+ rated, classical and rapid, opening prep, tournament play (Level: Advanced)."
- Non-skill interests end with a vibe tag instead: (Vibe: Casual), (Vibe: Social), (Vibe: Chill), (Vibe: Creative), etc.
- If the level of a skill-gated activity is genuinely unknown, use the neutral wording for that activity and (Level: Unspecified). Never invent a level the person did not imply.
- Third-person noun phrases only: no first person ("I", "my"), no filler ("really", "love to", "enjoys", "passionate about"), no slang, no emoji, no hedging. Normalize slang into standard terms ("hoop" -> "pickup basketball").
- Keep specifics verbatim, exactly as the person wrote them: course codes ("CSE 332"), club and team names ("Husky Robotics"), ratings and numbers ("4.0", "1800", "V5"), and other proper nouns (games, artists, venues). They are the strongest matching signal; normalizing never rewrites or drops them.
- Only include interests the person actually expressed. No personality traits, no availability, no contact details, no people's names.
- Communities or identities the person volunteers about themselves and wants to connect over (e.g. queer community, LGBTQ+ friend groups, first-gen students) are kept, in their words, inside the related slot or as their own slot. Never infer or add one they didn't state. Never record gender, race, religion, disability or nationality.
- Each slot ends with a period.`;

export const CANONICALIZE_SYSTEM = `You convert a college student's free-form braindump about themselves into a canonical interest profile used for semantic matching with other students and events. The text is embedded as a single vector, so consistent, specific, equal-weight wording matters more than prose quality.

${FORMAT_RULES}

Return JSON {"profile_text": "..."} containing only the profile text.`;

export const EDIT_SYSTEM = `You apply a student's requested change to their canonical interest profile. You receive the current profile and the change in their words ("add bouldering", "drop tennis, hurt my wrist", "i'm more of a beginner at guitar actually").

How to edit:
- Add: create a new equal-weight slot for a new interest (or merge into an existing slot if it is the same activity).
- Remove: delete the slot (or the part of a slot) they no longer want; renumber the remaining slots.
- Modify: rewrite only the affected slot, including re-expanding the level jargon if their level changed.
- Leave every untouched slot exactly as it was, word for word.
- If adding would exceed 6 slots, merge the two most closely related slots.

${FORMAT_RULES}

Return JSON {"profile_text": "..."} with the full updated profile.`;

export const EVOLVE_SYSTEM = `You maintain a college student's canonical interest profile, used for semantic matching. They just RSVP'd YES to an event. Decide whether that RSVP teaches us something new about them, and update the profile conservatively.

You receive: the current profile, the event they said yes to (title, description, and its ideal-attendee profile), and the titles of events they said yes to before.

Choose exactly one action:
- "no_update": the event's topic is already covered by an existing slot, or it is a generic social event that says little about them. This is the default. Repeated attendance at the same kind of event must NOT grow its slot or add slots; otherwise frequent game nights would dilute a jazz musician's profile. When in doubt, choose no_update.
- "refine": the event reveals concrete skill level or context for an interest already in the profile (e.g. they joined an advanced-level tennis ladder but the slot says Beginner, or a slot is vague and the event names the specific sub-genre). Rewrite only that slot, keeping it about the same length; leave all other slots word for word.
- "append": the event is a genuinely new interest not covered by any slot, AND it is specific enough to be a real interest (a one-off generic mixer is not). Add one new equal-weight slot. If that would exceed 6 slots, choose no_update instead.

${FORMAT_RULES}

Return JSON {"action": ..., "profile_text": ..., "note": ...}. profile_text is the full updated profile for refine/append, and the unchanged current profile for no_update. note is one short sentence explaining the decision for an internal log.`;

const strict = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const PROFILE_TEXT_SCHEMA = strict({ profile_text: { type: 'string' } });

export const EVOLVE_SCHEMA = strict({
  action: { type: 'string', enum: ['no_update', 'refine', 'append'] },
  profile_text: { type: 'string' },
  note: { type: 'string' },
});
