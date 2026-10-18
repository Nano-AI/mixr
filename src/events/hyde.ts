import { llm, pipelineLlm } from '../llm/index.ts';
import type { NewEvent } from '../types.ts';

// HyDE: instead of embedding the event blurb (which looks nothing like a person), write the profile of the
// ideal attendee in the exact canonical format user profiles use, and embed that. Same space, same shape.

const SYSTEM = `You write the profile of the IDEAL ATTENDEE for a campus event, so it can be matched against student profiles by embedding similarity.

Student profiles look exactly like this:
Core Interests:
[1] Competitive tennis, varsity match play, USTA 4.5, high-pace hitting partner, tournament sets (Level: Advanced).
[2] Tabletop board games, strategy games, Settlers of Catan, Wingspan, social game nights (Vibe: Casual).

Write the ideal attendee's profile in exactly that format, starting with the header line "Core Interests:" (so it lands in the same embedding space as real students).
Rules:
- 1 to 3 slots. The first slot is the event's core activity; add a slot only for a genuinely distinct facet (e.g. a social or skill angle the event clearly implies). Never pad.
- Each slot is a noun-rich phrase of about 10 to 15 words: the activity, its common synonyms, concrete specifics (formats, tools, titles, venues), then a parenthetical (Level: Beginner|Intermediate|Advanced|Any) for skill-gated activities or (Vibe: Casual|Social|Focused|Competitive) otherwise.
- Subspace expansion: translate casual or vague wording into the concrete vocabulary a matching student's profile would use. Examples:
  "pretty competitive doubles" -> "Competitive doubles tennis, USTA 4.0 to 5.0, high-pace rallies, match play, net play (Level: Advanced)."
  "chill catan night" -> "Tabletop board games, Settlers of Catan, strategy board games, social game night (Vibe: Casual)."
  "beginner friendly bouldering" -> "Indoor bouldering, rock climbing gym, V0 to V3 problems, learning technique (Level: Beginner)."
- Infer skill level from cues ("competitive", "casual", "no experience needed", "4.5+"); if none, use Level: Any for skill-gated activities.
- Describe the person's interests, not logistics: no dates, times, locations, capacity, host names, or prices.
- No first person, no filler, no slang, no emojis, no sentences about the event itself ("This event...").
Return JSON {"target_profile": "<the full profile text including the header line>"}.`;

const SCHEMA = {
  type: 'object',
  properties: { target_profile: { type: 'string' } },
  required: ['target_profile'],
  additionalProperties: false,
};

export const hydeFallback = (d: Pick<NewEvent, 'title' | 'description'>): string =>
  `Target Attendee:\n[1] ${d.title}. ${d.description}`.trim();

export async function hydeProfile(d: NewEvent): Promise<{ text: string; source: 'llm' | 'fallback'; error?: string }> {
  if (!pipelineLlm('hyde_profile')) return { text: hydeFallback(d), source: 'fallback' };
  try {
    const r = await llm().json<{ target_profile: string }>({
      name: 'hyde_profile',
      system: SYSTEM,
      input: `Event title: ${d.title}\nEvent description: ${d.description}\nGuest spots: ${d.capacity}`,
      schema: SCHEMA,
    });
    const text = r?.target_profile?.trim();
    if (!text) return { text: hydeFallback(d), source: 'fallback', error: 'empty target_profile' };
    return { text: /^(Core Interests|Target Attendee):/i.test(text) ? text : `Core Interests:\n${text}`, source: 'llm' };
  } catch (e) {
    return { text: hydeFallback(d), source: 'fallback', error: String(e) };
  }
}
