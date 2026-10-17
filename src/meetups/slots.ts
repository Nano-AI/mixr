const SLOT_HOURS = [12, 17]; // tune:
const MIN_LEAD_H = 4; // tune:
const COUNT = 6;

// Next weekday slots (local time) at least MIN_LEAD_H out, as ISO strings.
export function upcomingSlots(now: Date): string[] {
  const out: string[] = [];
  const earliest = now.getTime() + MIN_LEAD_H * 3600_000;
  for (const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()); out.length < COUNT; day.setDate(day.getDate() + 1)) {
    if (day.getDay() === 0 || day.getDay() === 6) continue;
    for (const h of SLOT_HOURS) {
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h);
      if (s.getTime() >= earliest && out.length < COUNT) out.push(s.toISOString());
    }
  }
  return out;
}

// "Thu 5 PM"
export function formatSlot(slot: string): string {
  const d = new Date(slot);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric' })}`;
}
