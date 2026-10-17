import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, useBus, type ApiUser, type Message } from '../api.ts';
import type { Notify } from '../App.tsx';
import { cx, dayKey, fmtDayLabel, fmtPhone, fmtTime, fmtWhen, initials } from '../util.ts';

type Pending = { id: number; text: string; failed?: boolean };

type Props = {
  phone: string;
  user: ApiUser | undefined;
  now: string | undefined;
  flashN: number;
  onClose: () => void;
  onShowUser: (id: number) => void;
  notify: Notify;
};

const key = (m: Message) => `${m.direction}|${m.simTime}|${m.text}`;
const GAP_SEPARATOR_MS = 30 * 60_000;
const GAP_RUN_MS = 5 * 60_000;

function mergeMessages(base: Message[], extra: Message[]): Message[] {
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const m of extra) if (!seen.has(key(m))) out.push(m);
  // Stable sort keeps server order for messages sharing a sim timestamp.
  return out
    .map((m, i) => ({ m, i, t: new Date(m.simTime).getTime() }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

export function PhonePane({ phone, user, now, flashN, onClose, onShowUser, notify }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingId = useRef(0);
  const stickToBottom = useRef(true);
  const sendingRef = useRef(false);
  sendingRef.current = sending;

  async function loadHistory() {
    try {
      const hist = await api.messages(phone);
      setMessages((prev) => mergeMessages(hist, prev));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  useBus((e) => {
    if (e.type === 'state' && loadError) void loadHistory();
    if (e.type !== 'message' || e.phone !== phone) return;
    const m: Message = { direction: e.direction, text: e.text, simTime: e.simTime };
    setMessages((prev) => mergeMessages(prev, [m]));
    if (e.direction === 'in') {
      setPending((p) => {
        const i = p.findIndex((x) => x.text === e.text && !x.failed);
        return i < 0 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      });
    } else if (!sendingRef.current && !rootRef.current?.contains(document.activeElement)) {
      setUnread((n) => n + 1);
    }
  });

  // Auto-scroll to the newest message unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending, sending, loaded]);

  useEffect(() => {
    if (!flashN) return;
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    inputRef.current?.focus({ preventScroll: true });
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 900);
    return () => clearTimeout(t);
  }, [flashN]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const id = ++pendingId.current;
    setDraft('');
    setPending((p) => [...p, { id, text }]);
    setSending(true);
    stickToBottom.current = true;
    try {
      await api.inbound(phone, text);
      await loadHistory();
      setPending((p) => p.filter((x) => x.id !== id));
    } catch (e) {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, failed: true } : x)));
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
    }
  }

  const snoozed = !!(user?.snoozedUntil && now && new Date(user.snoozedUntil) > new Date(now));
  const badge = !user ? 'new' : snoozed ? 'snoozed' : user.state;
  const title = user?.name ?? (user ? 'Unnamed' : 'New number');

  return (
    <div
      ref={rootRef}
      className={cx('phone', flashing && 'flash')}
      onMouseDown={() => setUnread(0)}
      onFocusCapture={() => setUnread(0)}
    >
      <div className="phone-notch" aria-hidden />
      <header className="phone-head">
        <span className="avatar">{initials(user?.name)}</span>
        <div className="phone-id">
          <div className="phone-name">
            {user ? (
              <button className="link" onClick={() => onShowUser(user.id)} title="Show profile in inspector">
                {title}
              </button>
            ) : (
              <span>{title}</span>
            )}
          </div>
          <div className="phone-sub">
            <span className="phone-number">{fmtPhone(phone)}</span>
            <span className={`badge badge-${badge}`} title={snoozed ? `Snoozed until ${fmtWhen(user?.snoozedUntil)}` : undefined}>
              {badge}
            </span>
            {user?.seeded && <span className="tag tag-muted">seeded</span>}
          </div>
        </div>
        {unread > 0 && (
          <span className="unread" title={`${unread} new message${unread === 1 ? '' : 's'}`}>
            {unread}
          </span>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close phone" title="Close">
          ×
        </button>
      </header>

      <div
        className="phone-body"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!loaded && <div className="phone-hint">Loading…</div>}
        {loadError && <div className="phone-hint error">Couldn’t load history: {loadError}</div>}
        {loaded && !loadError && messages.length === 0 && pending.length === 0 && (
          <div className="phone-hint">
            No messages yet.
            <br />
            Say hi to mixr.
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const t = new Date(m.simTime).getTime();
          const newDay = !prev || dayKey(prev.simTime) !== dayKey(m.simTime);
          const gap = !prev || t - new Date(prev.simTime).getTime() > GAP_SEPARATOR_MS;
          const endOfRun =
            !next || next.direction !== m.direction || new Date(next.simTime).getTime() - t > GAP_RUN_MS;
          return (
            <Fragment key={`${key(m)}#${i}`}>
              {(newDay || gap) && (
                <div className="sep">
                  {newDay ? `${fmtDayLabel(m.simTime)} · ` : ''}
                  {fmtTime(m.simTime)}
                </div>
              )}
              <div className={cx('bubble-row', m.direction, endOfRun && 'run-end')}>
                <div className={cx('bubble', m.direction)} title={fmtWhen(m.simTime)}>
                  {m.text}
                </div>
              </div>
              {endOfRun && <div className={cx('stamp', m.direction)}>{fmtTime(m.simTime)}</div>}
            </Fragment>
          );
        })}
        {pending.map((p) => (
          <div key={p.id} className="bubble-row in run-end">
            <div
              className={cx('bubble', 'in', 'pending', p.failed && 'failed')}
              title={p.failed ? 'Not delivered, click to dismiss' : 'Sending…'}
              onClick={() => p.failed && setPending((x) => x.filter((y) => y.id !== p.id))}
            >
              {p.text}
            </div>
            {p.failed && <div className="stamp in error">not delivered · tap to dismiss</div>}
          </div>
        ))}
        {sending && (
          <div className="bubble-row out">
            <div className="bubble out typing" aria-label="mixr is typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <form
        className="phone-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={inputRef}
          className="input"
          placeholder={sending ? 'mixr is replying…' : 'Text message'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={sending}
          aria-label={`Message from ${fmtPhone(phone)}`}
        />
        <button className="send-btn" type="submit" disabled={sending || !draft.trim()} aria-label="Send">
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M10 16V4M10 4l-5 5M10 4l5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}
