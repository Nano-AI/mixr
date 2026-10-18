// Readable renderers for trace payloads. Payload shapes come from backend modules and may vary slightly,
// so every accessor is defensive and anything unrecognized falls back to pretty JSON.
import type { ReactNode } from 'react';
import type { ApiEvent, ApiUser, TraceEntry } from '../api.ts';
import { cx, fmtNum } from '../util.ts';

type Obj = Record<string, unknown>;
export type TraceCtx = {
  usersById: Map<number, ApiUser>;
  eventsById: Map<number, ApiEvent>;
};

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
function get(o: unknown, ...keys: string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function parseMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}
const fix = (n: number | null, d = 3) => (n == null ? '—' : n.toFixed(d));

function userName(ctx: TraceCtx, o: unknown): string {
  const n = str(get(o, 'name', 'userName', 'label'));
  if (n) return n;
  const id = num(get(o, 'userId', 'user_id', 'id'));
  return id != null ? (ctx.usersById.get(id)?.name ?? `user #${id}`) : '?';
}

function eventTitle(ctx: TraceCtx, t: TraceEntry): string | null {
  const fromData = str(get(t.data, 'title', 'eventTitle'));
  if (fromData) return fromData;
  const id = num(get(t.data, 'eventId', 'event_id')) ?? t.refId;
  return id != null ? (ctx.eventsById.get(id)?.title ?? `event #${id}`) : null;
}

export function eventIdOf(t: TraceEntry, ctx: TraceCtx): number | null {
  if (!['wave', 'rocchio', 'hyde', 'recall', 'rerank'].includes(t.kind)) return null;
  const id = num(get(t.data, 'eventId', 'event_id')) ?? (['wave', 'rocchio', 'hyde'].includes(t.kind) ? t.refId : null);
  return id != null && ctx.eventsById.has(id) ? id : null;
}

export function userIdOf(t: TraceEntry, ctx: TraceCtx): number | null {
  if (!['profile_update', 'agent'].includes(t.kind)) return null;
  const id = num(get(t.data, 'userId', 'user_id')) ?? t.refId;
  return id != null && ctx.usersById.has(id) ? id : null;
}

function recallHits(d: unknown): unknown[] {
  return Array.isArray(d) ? d : arr(get(d, 'hits', 'top', 'results', 'candidates'));
}
function simOf(h: unknown): number | null {
  return num(get(h, 'similarity', 'sim', 'score', 'cos'));
}
function rerankPicks(d: unknown): unknown[] {
  return Array.isArray(d) ? d : arr(get(d, 'picks', 'results'));
}
function waveInvited(d: unknown): unknown[] {
  return arr(get(d, 'invited', 'invitees', 'invites', 'picks'));
}
function agentCalls(d: unknown): unknown[] {
  const direct = arr(get(d, 'tools', 'calls', 'toolCalls', 'tool_calls', 'functionCalls'));
  if (direct.length) return direct;
  // Possibly a list of turns/steps each holding calls.
  return arr(get(d, 'turns', 'steps', 'rounds')).flatMap((s) => arr(get(s, 'tools', 'calls', 'toolCalls', 'tool_calls')));
}
const countOf = (v: unknown): number | null => (Array.isArray(v) ? v.length : num(v));

// ---------------- summaries ----------------

export function summarize(t: TraceEntry, ctx: TraceCtx): string {
  const d = t.data;
  switch (t.kind) {
    case 'recall': {
      const hits = recallHits(d);
      const label = str(get(d, 'label', 'purpose', 'source'));
      const top = hits[0];
      const kw = hits.filter((h) => arr(get(h, 'keywords')).length).length;
      return `${label ? `${label} · ` : ''}${hits.length} hits${kw ? ` · ${kw} keyword` : ''}${top ? ` · top ${userName(ctx, top)} ${fix(simOf(top))}` : ''}`;
    }
    case 'rerank': {
      const picks = rerankPicks(d);
      const purpose = str(get(d, 'purpose'));
      const cands = countOf(get(d, 'candidates', 'candidateCount', 'n'));
      const k = num(get(d, 'k'));
      return `${purpose ? `${purpose} · ` : ''}${picks.length} pick${picks.length === 1 ? '' : 's'}${cands != null ? ` from ${cands}` : ''}${k != null ? ` (k=${k})` : ''}`;
    }
    case 'wave': {
      const title = eventTitle(ctx, t);
      const w = num(get(d, 'wave', 'waveNumber'));
      const inv = waveInvited(d);
      const reason = str(get(d, 'stopped', 'stop', 'reason', 'skipped'));
      return `${title ?? 'event'} · wave ${w ?? '?'} · ${inv.length} invited${reason ? ` · ${reason}` : ''}`;
    }
    case 'rocchio': {
      const title = eventTitle(ctx, t);
      return `${title ?? 'event'} · ${countOf(get(d, 'yes')) ?? 0} yes / ${countOf(get(d, 'noVibe', 'no_vibe')) ?? 0} no-vibe · cos ${fix(num(get(d, 'cosToE0', 'cos')))}`;
    }
    case 'profile_update': {
      const who = userName(ctx, isObj(d) ? { ...d, id: get(d, 'userId') ?? t.refId } : { id: t.refId });
      const action = str(get(d, 'action', 'source', 'reason', 'via'));
      return `${who}${action ? ` · ${action}` : ''}`;
    }
    case 'agent': {
      const who = userName(ctx, isObj(d) ? { ...d, id: get(d, 'userId') ?? t.refId } : { id: t.refId });
      const calls = agentCalls(d);
      const names = calls.map((c) => str(get(c, 'name', 'tool')) ?? '?');
      return `${who} · ${calls.length ? names.join(', ') : 'no tools'}`;
    }
    case 'llm': {
      const u = get(d, 'usage');
      const i = num(get(u, 'input_tokens', 'inputTokens', 'prompt_tokens'));
      const o = num(get(u, 'output_tokens', 'outputTokens', 'completion_tokens'));
      return `${str(get(d, 'purpose', 'name')) ?? 'call'}${i != null || o != null ? ` · ${fmtNum(i ?? 0)} in / ${fmtNum(o ?? 0)} out` : ''}`;
    }
    case 'embed':
      return `${num(get(d, 'count')) ?? 0} embedded · ${num(get(d, 'cached')) ?? 0} cached · ${fmtNum(num(get(d, 'tokens')) ?? 0)} tok`;
    case 'job': {
      const err = str(get(d, 'error'));
      const payload = get(d, 'payload');
      const bits = isObj(payload)
        ? Object.entries(payload)
            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
            .join(' ')
        : '';
      return `${str(get(d, 'kind')) ?? 'job'}${bits ? ` ${bits}` : ''}${err ? ' · FAILED' : ''}`;
    }
    case 'hyde':
      return eventTitle(ctx, t) ?? 'target profile';
    default:
      return '';
  }
}

// ---------------- bodies ----------------

export function TraceBody({ t, ctx }: { t: TraceEntry; ctx: TraceCtx }): ReactNode {
  const d = t.data;
  try {
    switch (t.kind) {
      case 'recall':
        return <RecallView d={d} ctx={ctx} />;
      case 'rerank':
        return <RerankView d={d} ctx={ctx} />;
      case 'wave':
        return <WaveView d={d} ctx={ctx} />;
      case 'rocchio':
        return <RocchioView d={d} ctx={ctx} />;
      case 'profile_update':
        return <ProfileDiff d={d} />;
      case 'agent':
        return <AgentView d={d} />;
      case 'hyde': {
        const text = str(get(d, 'targetProfile', 'target_profile', 'hydeProfile', 'profile', 'text'));
        return text ? <pre className="profile-text">{text}</pre> : <Json v={d} />;
      }
      case 'job': {
        const err = str(get(d, 'error'));
        return (
          <>
            {err && <div className="error-box">{err}</div>}
            <Json v={get(d, 'payload') ?? d} />
          </>
        );
      }
      case 'llm':
      case 'embed':
        return <Json v={d} />;
      default:
        return <Json v={d} />;
    }
  } catch {
    return <Json v={d} />;
  }
}

export function Json({ v }: { v: unknown }) {
  let s: string;
  try {
    s = JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    s = String(v);
  }
  return <pre className="json">{s}</pre>;
}

function SimBar({ value, max }: { value: number | null; max: number }) {
  const pct = value == null || max <= 0 ? 0 : Math.max(2, Math.min(100, (value / max) * 100));
  return (
    <span className="simbar">
      <span className="simbar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

function RecallView({ d, ctx }: { d: unknown; ctx: TraceCtx }) {
  const hits = recallHits(d);
  if (!hits.length) return <Json v={d} />;
  const sims = hits.map(simOf).filter((x): x is number => x != null);
  const max = sims.length ? Math.max(...sims) : 1;
  const extra = isObj(d)
    ? Object.entries(d).filter(([k, v]) => !['hits', 'top', 'results', 'candidates'].includes(k) && (typeof v !== 'object' || v === null))
    : [];
  const excl = isObj(d) ? arr(d.exclude).length : 0;
  return (
    <div>
      {(extra.length > 0 || excl > 0) && (
        <div className="kv-row">
          {extra.map(([k, v]) => (
            <span key={k} className="kv">
              <span className="kv-k">{k}</span> {String(v)}
            </span>
          ))}
          {excl > 0 && (
            <span className="kv">
              <span className="kv-k">excluded</span> {excl}
            </span>
          )}
        </div>
      )}
      <ol className="ranked">
        {hits.map((h, i) => (
          <li key={i}>
            <span className="rank">{i + 1}</span>
            <span className="ranked-name">{userName(ctx, h)}</span>
            <SimBar value={simOf(h)} max={max} />
            <span className="mono small">{fix(simOf(h))}</span>
            {arr(get(h, 'keywords')).length > 0 && (
              <span className="tag tag-accent" title="BM25 keyword match: these words from the ask are rare and in their profile">
                keyword: {arr(get(h, 'keywords')).map(String).join(', ')}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RerankView({ d, ctx }: { d: unknown; ctx: TraceCtx }) {
  const picks = rerankPicks(d);
  const target = str(get(d, 'target'));
  if (!picks.length && !target) return <Json v={d} />;
  return (
    <div>
      {target && (
        <details className="collapsible inline">
          <summary>target</summary>
          <pre className="profile-text">{target}</pre>
        </details>
      )}
      {picks.length === 0 && <div className="muted small">No picks: the reranker judged every candidate a poor fit.</div>}
      <ol className="picks">
        {picks.map((p, i) => (
          <li key={i}>
            <div className="pick-head">
              <span className="rank">{i + 1}</span>
              <b>{userName(ctx, p)}</b>
            </div>
            {str(get(p, 'reason')) && (
              <div className="pick-reason">
                <span className="kv-k">reason</span> {str(get(p, 'reason'))}
              </div>
            )}
            {str(get(p, 'pitch')) && <div className="pitch">“{str(get(p, 'pitch'))}”</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function WaveView({ d, ctx }: { d: unknown; ctx: TraceCtx }) {
  const invited = waveInvited(d);
  const stats: [string, string][] = [
    ['wave', str(get(d, 'wave', 'waveNumber')) ?? '—'],
    ['n', str(get(d, 'n')) ?? '—'],
    ['pYes', fix(num(get(d, 'pYes', 'p_yes')), 2)],
    ['spots left', str(get(d, 'spotsLeft', 'spots_left')) ?? '—'],
  ];
  const nextAt = str(get(d, 'nextWaveAt', 'next_wave_at'));
  return (
    <div>
      <div className="stat-row">
        {stats.map(([k, v]) => (
          <div key={k} className="stat">
            <div className="stat-v">{v}</div>
            <div className="stat-k">{k}</div>
          </div>
        ))}
      </div>
      {nextAt && <div className="muted small">next wave at {nextAt}</div>}
      {invited.length > 0 && (
        <ul className="picks">
          {invited.map((p, i) => {
            const src = str(get(p, 'source'));
            return (
              <li key={i}>
                <div className="pick-head">
                  <b>{userName(ctx, p)}</b>
                  {src && (
                    <span className={cx('src', src === 'E0' ? 'src-e0' : 'src-et')} title={src === 'E0' ? 'Exploration buffer from the original target E0' : 'From the drifted target Et'}>
                      {src}
                    </span>
                  )}
                </div>
                {str(get(p, 'pitch')) && <div className="pitch">“{str(get(p, 'pitch'))}”</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RocchioView({ d, ctx }: { d: unknown; ctx: TraceCtx }) {
  const cos = num(get(d, 'cosToE0', 'cos'));
  const yes = get(d, 'yes');
  const noVibe = get(d, 'noVibe', 'no_vibe');
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => (isObj(x) ? userName(ctx, x) : (ctx.usersById.get(Number(x))?.name ?? String(x)))) : []);
  return (
    <div>
      <div className="stat-row">
        <div className="stat good">
          <div className="stat-v">{countOf(yes) ?? 0}</div>
          <div className="stat-k">yes (pull +0.25)</div>
        </div>
        <div className="stat bad">
          <div className="stat-v">{countOf(noVibe) ?? 0}</div>
          <div className="stat-k">no-vibe (push −0.05)</div>
        </div>
        <div className="stat">
          <div className="stat-v">{fix(cos)}</div>
          <div className="stat-k">cos(Et, E0)</div>
        </div>
      </div>
      {cos != null && (
        <div className="drift">
          <div className="drift-bar">
            <div className="drift-fill" style={{ width: `${Math.max(0, Math.min(100, ((cos - 0.6) / 0.4) * 100))}%` }} />
          </div>
          <span className="muted small">Et = norm(0.70·E0 + 0.25·mean(yes) − 0.05·mean(no_vibe))</span>
        </div>
      )}
      {names(yes).length > 0 && <div className="small">yes: {names(yes).join(', ')}</div>}
      {names(noVibe).length > 0 && <div className="small">no-vibe: {names(noVibe).join(', ')}</div>}
    </div>
  );
}

function ProfileDiff({ d }: { d: unknown }) {
  const before = str(get(d, 'before', 'old', 'previous'));
  const after = str(get(d, 'after', 'new', 'profile', 'profileText', 'profile_text'));
  const note = str(get(d, 'note'));
  const action = str(get(d, 'action'));
  if (after == null) return <Json v={d} />;
  const ops: { op: ' ' | '+' | '-'; l: string }[] =
    before == null ? after.split('\n').map((l) => ({ op: ' ' as const, l })) : lineDiff(before, after);
  return (
    <div>
      {(action || note) && (
        <div className="kv-row">
          {action && (
            <span className="kv">
              <span className="kv-k">action</span> {action}
            </span>
          )}
          {note && (
            <span className="kv">
              <span className="kv-k">note</span> {note}
            </span>
          )}
        </div>
      )}
      <pre className="diff">
        {ops.map((o, i) => (
          <div key={i} className={o.op === '+' ? 'diff-add' : o.op === '-' ? 'diff-del' : 'diff-same'}>
            {o.op === ' ' ? '  ' : `${o.op === '-' ? '−' : '+'} `}
            {o.l}
          </div>
        ))}
      </pre>
      {before == null && <div className="muted small">new profile</div>}
    </div>
  );
}

function AgentView({ d }: { d: unknown }) {
  const calls = agentCalls(d);
  const input = str(get(d, 'input', 'inbound', 'userText', 'text', 'message'));
  const reply = str(get(d, 'reply', 'final', 'output', 'response', 'outText'));
  if (!calls.length && !input && !reply) return <Json v={d} />;
  return (
    <div className="agent">
      {input && (
        <div className="agent-msg in">
          <span className="kv-k">student</span> {input}
        </div>
      )}
      {calls.map((c, i) => {
        const args = parseMaybe(get(c, 'args', 'arguments', 'input', 'params'));
        const result = parseMaybe(get(c, 'result', 'output', 'response'));
        return (
          <div key={i} className="tool-call">
            <div className="tool-name">
              <span className="fn">ƒ</span> {str(get(c, 'name', 'tool')) ?? '?'}
              <span className="tool-args">{args === undefined ? '()' : `(${compact(args)})`}</span>
            </div>
            {result !== undefined && (
              <details className="collapsible inline">
                <summary>result</summary>
                <Json v={result} />
              </details>
            )}
          </div>
        );
      })}
      {reply && (
        <div className="agent-msg out">
          <span className="kv-k">mixr</span> {reply}
        </div>
      )}
    </div>
  );
}

function compact(v: unknown): string {
  if (isObj(v))
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${typeof x === 'string' ? JSON.stringify(x.length > 120 ? `${x.slice(0, 117)}…` : x) : JSON.stringify(x)}`)
      .join(', ');
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

/** Minimal LCS line diff (profiles are a handful of lines). */
function lineDiff(a: string, b: string): { op: ' ' | '+' | '-'; l: string }[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: ' ' | '+' | '-'; l: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ op: ' ', l: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', l: A[i++]! });
    else out.push({ op: '+', l: B[j++]! });
  }
  while (i < n) out.push({ op: '-', l: A[i++]! });
  while (j < m) out.push({ op: '+', l: B[j++]! });
  return out;
}
