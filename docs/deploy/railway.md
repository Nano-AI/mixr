> **Status:** not used right now. mixr runs as a monolith on polarcrest (see README → Deploy). This guide predates the integration branch (it describes the SQLite build) and is kept as a starting point if we move to Railway later.

# Deploying mixr on Railway

The bot runs as one always-on Node process with one SQLite file. Railway fits: persistent volume, long-running process, HTTPS on a custom domain. (Vercel doesn't: serverless functions have no persistent disk and can't run the 60s `tick` loop.)

Domain: `joinmixr.club` (Porkbun). The bot lives at **`api.joinmixr.club`**; the bare domain stays free for a landing page later.

## Before you deploy

The server isn't built yet. `npm start` runs `src/server.ts` (task W2). It must:

- listen on `process.env.PORT` (Railway sets this; don't hard-code a port)
- serve `GET /health` (Railway health check) and `POST /webhook/photon`
- start the scheduler: `setInterval(() => tick(new Date()).catch(console.error), 60_000)`. Unhandled rejections kill Node.

`.nvmrc` pins Node 24 (needed for `node:sqlite` and running `.ts` directly).

## 1. Create the service

1. railway.app → **New Project** → **Deploy from GitHub repo** → `Nano-AI/mixr`, branch `main`.
2. Railway detects Node and runs `npm start`. No build step is needed.

## 2. Add the database volume

1. Service → **Settings → Volumes → Add Volume**, mount path `/data`.
2. Without this, every deploy wipes all users and meetups.

## 3. Set variables

Service → **Variables**:

| Name | Value |
|---|---|
| `DB_PATH` | `/data/mixr.db` |
| `TZ` | `America/Los_Angeles` |
| `TRANSPORT` | `photon` |
| `ANTHROPIC_API_KEY` | your key (omit and set `LLM=fake` to demo without it) |
| Photon keys | whatever W2's `photon.ts` header comment lists |

Never commit these. `.env` is gitignored for local use only.

## 4. Point the domain

1. Service → **Settings → Networking → Custom Domain** → `api.joinmixr.club`. Railway shows a CNAME target.
2. Porkbun → Domain Management → `joinmixr.club` → **DNS** → add a record:
   - Type `CNAME`, Host `api`, Answer = Railway's target, TTL default.
3. Wait a few minutes. Railway issues HTTPS automatically. Check `https://api.joinmixr.club/health`.

## 5. Connect Photon

In the Photon dashboard (Beta / v2), set the webhook URL to:

```
https://api.joinmixr.club/webhook/photon
```

Text the Photon number from a phone and watch Railway's **Deployments → Logs**.

## Demo-day fallback (no Railway)

Run locally and tunnel:

```bash
npm start                                      # in one terminal
cloudflared tunnel --url http://localhost:3000 # in another; prints a temporary https URL
```

Paste the printed URL + `/webhook/photon` into Photon. The URL changes on every restart. If Photon itself fails, `npm run chat` is the laptop-only fallback.

## Cost

- Railway: trial credit, then about $5/month. Remove the service after the hackathon if you're not keeping it.
- Domain: free first year via the MLH code, about $16/year after. Turn off auto-renew in Porkbun if you're not keeping it.
