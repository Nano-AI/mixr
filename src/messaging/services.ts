import { existsSync } from 'node:fs';
import { buildProfile, confirmProfile } from '../matching/profile.ts';
import { openInvitations, recordResponse } from '../meetups/responses.ts';
import { recordFeedback } from '../meetups/feedback.ts';
import { listPublicEvents, joinEvent } from '../meetups/events.ts';
import { sendCode } from './email.ts';
import { converse } from './agent.ts';

// Missing teammate modules are explicit integration gaps, never replacement algorithms.
const slotsUrl = new URL('../meetups/slots.ts', import.meta.url);
const plannerUrl = new URL('../meetups/planner.ts', import.meta.url);
const schedulerUrl = new URL('../meetups/scheduler.ts', import.meta.url);
const slots = existsSync(slotsUrl) ? await import(slotsUrl.href) : undefined;
const planner = existsSync(plannerUrl)
  ? await import(plannerUrl.href)
  : undefined;
const scheduler = existsSync(schedulerUrl)
  ? await import(schedulerUrl.href)
  : undefined;
export const services = {
  buildProfile,
  confirmProfile,
  openInvitations,
  recordResponse,
  recordFeedback,
  listPublicEvents,
  joinEvent,
  sendCode,
  converse,
  upcomingSlots: (now: Date): string[] => slots?.upcomingSlots(now) ?? [],
  planMeetups: async (now: Date): Promise<void> => {
    if (planner) await planner.planMeetups(now);
  },
};
export type Services = typeof services;
export const integrationStatus = {
  slots: !!slots,
  planner: !!planner,
  scheduler: !!scheduler,
};
export async function tick(now: Date): Promise<void> {
  if (scheduler) await scheduler.tick(now);
}
