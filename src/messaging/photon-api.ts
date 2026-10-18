import { config } from '../config.ts';

// Photon's Spectrum REST API (https://spectrum.photon.codes), Basic auth base64(projectId:projectSecret).
// Only what /join needs: register a phone as a shared-line user, which assigns the number they text mixr at.
// Registration is idempotent per phone (Photon returns the same user), but every NEW phone uses a plan slot,
// so tests and dev runs never call the real API (inject a fetch with setPhotonFetch).

export const PHOTON_API = 'https://spectrum.photon.codes';
const TIMEOUT_MS = 10_000; // tune:

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
export const setPhotonFetch = (f: Fetch | null): void => void (fetchImpl = f);

export type RegisterResult =
  | { kind: 'ok'; id: string; assignedPhoneNumber: string }
  | { kind: 'full'; message: string } // the plan's shared-user cap is reached
  | { kind: 'error'; status?: number; message: string };

// The public tap-to-text deep link: Photon redirects to an sms: link for the user's assigned number.
export const redirectLink = (photonUserId: string, msg = 'hi mixr'): string =>
  `${PHOTON_API}/users/${encodeURIComponent(photonUserId)}/redirect?msg=${encodeURIComponent(msg)}`;

const E164 = /^\+[1-9]\d{6,14}$/;

export async function registerSharedUser(phone: string, firstName?: string): Promise<RegisterResult> {
  const { photonProjectId: projectId, photonProjectSecret: secret } = config;
  if (!projectId || !secret) return { kind: 'error', message: 'PROJECT_ID / PROJECT_SECRET are not set' };
  const f = fetchImpl ?? (process.env.VITEST ? null : fetch);
  if (!f) return { kind: 'error', message: 'refusing to call the real Photon API from tests (use setPhotonFetch)' };
  const redact = (s: string) => s.replaceAll(secret, '[redacted]').slice(0, 300);

  let res: Response;
  try {
    res = await f(`${PHOTON_API}/projects/${encodeURIComponent(projectId)}/users/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ type: 'shared', phoneNumber: phone, ...(firstName ? { firstName } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { kind: 'error', message: redact(`Photon unreachable: ${e instanceof Error ? e.message : String(e)}`) };
  }

  const body = (await res.json().catch(() => null)) as {
    succeed?: boolean;
    data?: { id?: unknown; assignedPhoneNumber?: unknown } | null;
    code?: unknown;
    message?: unknown;
  } | null;

  if (res.ok) {
    const d = body?.data;
    if (body?.succeed !== false && d && typeof d.id === 'string' && d.id && typeof d.assignedPhoneNumber === 'string' && E164.test(d.assignedPhoneNumber))
      return { kind: 'ok', id: d.id, assignedPhoneNumber: d.assignedPhoneNumber };
    return { kind: 'error', status: res.status, message: 'Photon returned an unexpected response' };
  }

  // Errors are {succeed:false, code, message}. The plan cap (maxSharedUsers) has no documented code, so any
  // client error that talks about a limit counts as "full" - unless it's a validation error or rate limiting.
  const detail = redact([body?.code, body?.message].filter((x) => typeof x === 'string').join(': ') || `HTTP ${res.status}`);
  const clientError = res.status >= 400 && res.status < 500 && res.status !== 429;
  if (clientError && /max|limit|full|quota|capacity|exceed/i.test(detail) && !/valid/i.test(detail)) return { kind: 'full', message: detail };
  return { kind: 'error', status: res.status, message: detail };
}
