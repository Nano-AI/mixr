import type { EventStatus, InviteStatus, IntroStatus } from '../api.ts';
import type { ReactNode } from 'react';

const INVITE_LABEL: Record<InviteStatus, string> = {
  invited: 'invited',
  yes: 'yes',
  no_busy: 'busy',
  no_vibe: 'not vibing',
  expired: 'expired',
  waitlisted: 'waitlisted',
  cancelled: 'cancelled',
  withdrawn: 'withdrawn',
};

export const INVITE_STATUSES = Object.keys(INVITE_LABEL) as InviteStatus[];
export const inviteLabel = (s: InviteStatus) => INVITE_LABEL[s] ?? s;

export function InviteChip({ status }: { status: InviteStatus }) {
  return <span className={`chip st-${status}`}>{inviteLabel(status)}</span>;
}

export function EventChip({ status }: { status: EventStatus }) {
  return <span className={`chip ev-${status}`}>{status}</span>;
}

export function IntroChip({ status }: { status: IntroStatus }) {
  return <span className={`chip in-${status}`}>{status.replace('_', ' ')}</span>;
}

export function Tag({ children, tone = 'muted', title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {children}
    </span>
  );
}
