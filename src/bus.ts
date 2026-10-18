import { EventEmitter } from 'node:events';
import type { BusEvent } from './types.ts';

// In-process pub/sub that the server streams to the dashboard over SSE.
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export const publish = (e: BusEvent): void => void emitter.emit('bus', e);

export function subscribe(fn: (e: BusEvent) => void): () => void {
  emitter.on('bus', fn);
  return () => emitter.off('bus', fn);
}
