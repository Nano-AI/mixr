# mixr demo deck

A static slide deck. Open `index.html` in a browser (or `python3 -m http.server` in this folder); arrow keys move between slides.

## Clips

Each slide's video slot is a `<figure data-clip="NAME">`. The deck plays `clips/NAME.webm` (or `.mp4`, poster `.jpg`) when the file exists and shows a placeholder when it doesn't.

| Slot | Status |
|---|---|
| `00-hero`, `03-onboarding`, `04-intro`, `07-tapback` | not recorded |
| `01-signup-desktop`, `02-signup-phone` | finished (trimmed, mp4 + webm + poster) |
| `05-host`, `06-matching`, `08-events` | raw dashboard recordings, untrimmed webm only |

To finish a raw one, run `scripts/demo/clip.sh <raw> <name> --in S --out S` (writes to `demo/out/`), then copy the results into `clips/`. Usage is at the top of the script. `scripts/demo/record-web.mjs` and `record-dashboard.mjs` re-record the site and the dashboard; `sim-server.mjs` is the stand-in backend for the site recordings.

## No PII

Same rule as the rest of the repo (see `CLAUDE.md`): demo users, fictional 555 numbers, no real names. The team slide credits roles.
