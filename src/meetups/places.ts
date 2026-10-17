import { db } from '../db.ts';
import type { Category } from '../types.ts';

export type Place = { id: string; name: string; meetSpot: string; categories: Category[]; aliases?: string[] };

// UW Seattle spots, hard-coded. Order matters: pickPlace takes the first free one per category.
// ponytail: meet spots are best-guess, walk past each before the demo.
export const PLACES: Place[] = [
  // Sport
  { id: 'denny-field', name: 'Denny Field', meetSpot: 'the field entrance off Stevens Way', categories: ['sport'] },
  { id: 'ima-fields', name: 'IMA Fields', meetSpot: 'the field gate by the IMA', categories: ['sport'], aliases: ['ima field', 'intramural fields'] },
  { id: 'ima', name: 'IMA (Intramural Activities Building)', meetSpot: 'the front desk', categories: ['sport'], aliases: ['ima', 'intramural', 'gym'] },
  { id: 'husky-track', name: 'Husky Track', meetSpot: 'the track entrance', categories: ['sport'], aliases: ['track'] },
  { id: 'wac', name: 'Waterfront Activities Center', meetSpot: 'the boat rental counter', categories: ['sport'], aliases: ['wac', 'kayak', 'canoe'] },
  { id: 'quad', name: 'The Quad', meetSpot: 'under the cherry trees', categories: ['sport', 'talk'], aliases: ['quad', 'liberal arts quad'] },
  { id: 'rainier-vista', name: 'Rainier Vista', meetSpot: 'the top of the steps facing Drumheller', categories: ['sport', 'talk'] },
  // Computer science
  { id: 'allen-center', name: 'Paul G. Allen Center (CSE)', meetSpot: 'the ground floor atrium', categories: ['other', 'talk'], aliases: ['allen center', 'cse', 'cse1'] },
  { id: 'gates-center', name: 'Bill & Melinda Gates Center (CSE2)', meetSpot: 'the ground floor atrium', categories: ['other', 'talk'], aliases: ['gates center', 'cse2', 'cse 2'] },
  // Libraries and study spaces
  { id: 'odegaard', name: 'Odegaard Library', meetSpot: 'the 1st floor entrance', categories: ['other', 'talk'], aliases: ['ode', 'odegaard'] },
  { id: 'suzzallo', name: 'Suzzallo Library', meetSpot: 'the Reading Room entrance', categories: ['talk', 'other'], aliases: ['suzz', 'suzzallo', 'reading room'] },
  { id: 'mary-gates-hall', name: 'Mary Gates Hall', meetSpot: 'the commons atrium', categories: ['other', 'talk'], aliases: ['mgh', 'mary gates'] },
  // Social spaces
  { id: 'hub', name: 'HUB', meetSpot: 'the 1st floor lounge', categories: ['talk', 'other'], aliases: ['hub', 'husky union'] },
  { id: 'husky-den', name: 'Husky Den (HUB)', meetSpot: 'the HUB lower level food court', categories: ['talk'], aliases: ['husky den'] },
  { id: 'red-square', name: 'Red Square', meetSpot: 'the Broken Obelisk', categories: ['talk'], aliases: ['red square'] },
  { id: 'drumheller', name: 'Drumheller Fountain', meetSpot: 'the fountain edge', categories: ['talk'], aliases: ['drumheller', 'frosh pond'] },
  { id: 'sylvan-grove', name: 'Sylvan Grove', meetSpot: 'the columns', categories: ['talk'], aliases: ['sylvan'] },
  // Cafes
  { id: 'by-george', name: 'By George Cafe (Odegaard)', meetSpot: 'the cafe counter', categories: ['talk'], aliases: ['by george'] },
  { id: 'local-point', name: 'Local Point', meetSpot: 'the main entrance', categories: ['talk'], aliases: ['local point', 'lp'] },
  { id: 'cafe-allegro', name: 'Cafe Allegro', meetSpot: 'the alley entrance off the Ave', categories: ['talk'], aliases: ['allegro'] },
  { id: 'cafe-solstice', name: 'Cafe Solstice', meetSpot: 'the front counter', categories: ['talk'], aliases: ['solstice'] },
];

// First place for the category not already taken by an open meetup in that slot.
export function pickPlace(category: Category, slot: string): string {
  const fits = PLACES.filter((p) => p.categories.includes(category));
  const taken = new Set(
    (db.prepare("SELECT place_id FROM meetups WHERE slot = ? AND state IN ('proposed','confirmed')").all(slot) as { place_id: string }[]).map((r) => r.place_id),
  );
  return (fits.find((p) => !taken.has(p.id)) ?? fits[0]).id;
}

// For "YES 12 cafe allegro": the place whose name or alias appears as whole words, longest match wins
// (so "cse2" beats "cse" and "ima" doesn't match "animal").
export function findPlace(text: string): Place | undefined {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `;
  let best: Place | undefined;
  let bestLen = 0;
  for (const p of PLACES) {
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      const k = n.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
      if (k.length > bestLen && t.includes(` ${k} `)) [best, bestLen] = [p, k.length];
    }
  }
  return best;
}
