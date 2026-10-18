import { AsyncLocalStorage } from 'node:async_hooks';

// Which world a piece of work runs in. Two pools never meet:
//   demo: the seeded students. Simulated clock (fast-forward in the dashboard); nothing is ever delivered.
//   real: people who joined through the website + iMessage. Wall-clock time; messages go out over Photon.
// deliver: whether outbound texts may leave the server at all.
// quietUser: someone the dashboard is acting as. Replies to them stay in the dashboard; everything else (data
//   changes, texts to other people) behaves like real life.
// Code that runs without a context is demo + no delivery, so a missed entry point can't text a real phone.

export type Pool = 'demo' | 'real';
export type RunContext = { pool: Pool; deliver: boolean; quietUser?: number };

const store = new AsyncLocalStorage<RunContext>();
const DEFAULT: RunContext = { pool: 'demo', deliver: false };

export const context = (): RunContext => store.getStore() ?? DEFAULT;
export const currentPool = (): Pool => context().pool;

export function runIn<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

// Background work for a pool: real-pool jobs deliver, demo-pool jobs never do.
export const poolContext = (pool: Pool): RunContext => ({ pool, deliver: pool === 'real' });

// users.seeded marks the demo pool.
export const poolOf = (seeded: boolean): Pool => (seeded ? 'demo' : 'real');
