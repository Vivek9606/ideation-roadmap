# Betterhood growth roadmap

An interactive dashboard for Betterhood's organic growth plan: SEO, AEO, GEO, social channels, website and app bets, the frameworks behind them, and a place to discuss each one. Every comment, note, status change, proposed idea and meeting log is saved as a git commit, so all conversations are version-controlled.

Live: https://vivek9606.github.io/ideation-roadmap/

## Using it

1. Open **Settings**, add your name and a GitHub token (see below).
2. Click any initiative or channel to open it. Change its status or owner, write notes, add comments.
3. Use **Discussion** for meeting notes, a general thread, and proposing new ideas (they appear on the roadmap marked *Proposed*).
4. Changes collect in a draft (kept in your browser, even across reloads). Click **Save to GitHub**, write a commit message, and they're committed to `data/notes.json`.
5. **History** lists every commit with a link to its diff.

If two people save at the same time, the dashboard re-reads the latest file and applies your changes on top, so nobody's notes are overwritten.

### The token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- Repository access: **Only select repositories → ideation-roadmap**
- Permissions: **Contents: Read and write** (Metadata: read is added automatically)
- Set an expiry date

The token is stored only in your browser (localStorage, or sessionStorage if you untick "Remember") and is sent only to `api.github.com`. People without a token can still read everything; they just can't save.

## Files

| Path | What |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The dashboard (no build step) |
| `data/roadmap.json` | The plan: pillars, phases, initiatives, channels, frameworks, KPIs. Edit this to change the roadmap itself |
| `data/notes.json` | Discussion data written by the dashboard. Don't hand-edit while people are using it |

## Run locally

```bash
npx serve .
```

Opening `index.html` straight from disk won't work, because browsers block `fetch` on `file://`.

## Deploy

GitHub Pages serves the `main` branch root: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**. `.nojekyll` makes Pages serve files as-is.
