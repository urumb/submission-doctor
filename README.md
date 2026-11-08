# Submission Doctor

**Check your hackathon repo before the judges do.**

Paste a GitHub link and get a readiness score, a blunt roast, a prioritised fix list, a share-ready score card and a README badge. Built for the BharatCode Build League, free to use and free to host. Everything runs in your browser, so there is no server and no signup.

**[Try it live](https://urumb.github.io/submission-doctor/)** · **[See an example report](https://urumb.github.io/submission-doctor/?example=1)**

![demo](demo.gif)

## Why it exists

Hackathon projects lose votes for boring reasons: no demo GIF, no install steps, a missing `BharatCode.txt`, or a leaked API key. Stars and votes decide a big part of the ranking, and people rarely check these basics. Submission Doctor checks them in seconds and tells you what to fix first.

## What it does

- **Readiness check (0 to 100).** Public repo, `BharatCode.txt` in the root, README quality (pitch, install steps, demo, BharatCode mention), live demo link, license, description, topics, commit history and obvious committed secrets.
- **Where you'd rank.** A snapshot of the public Build League leaderboard plus a votes what-if calculator. Score is half GitHub stars and half website votes, each measured against the current leader, so right now one vote and one star are each worth roughly 0.8 points (the exact values shift as the leader changes).
- **Fix-it kit.** Copy-paste `README.md`, `BharatCode.txt`, `.gitignore` and `.env.example` templates for whatever your check found missing.
- **Score card and badge.** Download a share image and copy a README badge.
- **Share links.** `?repo=owner/name` opens a finished report. `?example=1` opens a bundled example instantly, with no GitHub requests.
- **Fast.** The GitHub requests run in parallel (about 1.5 s for a full check) and results are cached for 10 minutes per tab.
- **Honest demo check.** It only counts a README image or GIF if the file really exists in the repo, so a broken `![demo](demo.gif)` is caught.
- **AI review (optional).** Connect your BharatCode API key and the model reads your README and results, then tells you what to fix first and writes your submission summary, README intro and launch post.

## Connect it to BharatCode

The checks, score and leaderboard panel are plain code and need no model. The optional **AI review** calls the BharatCode API:

1. Open the site and scroll to **Connect BharatCode**. The base URL (`https://bharatcode.ai/api/model/v1`) and model (`qwen-3.8-27b`) are pre-filled and editable.
2. Paste your BharatCode API key and click **Test connection**.
3. Run a check, then click **Run AI review**. With no key entered, that button takes you straight to the key box.

It talks to the standard `/chat/completions` endpoint, so it also works with any other OpenAI-compatible API. It needs an account with BharatCode API access (a Lite or Pro plan, or student access: a `.ac.in` or `.edu.in` email, or a request to contact@bharatcode.ai with enrolment proof).

### How your key is handled

- It is held in memory only. It is never saved to storage, and it disappears when you close or reload the tab.
- It is sent only over HTTPS (or to a local test server) to the endpoint you enter, with no cookies or referrer, and redirects are refused.
- It is scrubbed from any error text, and there is a **Forget key** button.
- The page ships a strict Content Security Policy that blocks injected scripts, and there is no server, so nothing is ever sent to the author.
- Even so, use a key you can revoke, and only on a device you trust.

## Run it locally

No build step. Serve the folder with any static server:

```bash
python -m http.server 8765
```

Open http://localhost:8765, paste a repo link and click **Diagnose**.

## Deploy free on GitHub Pages

1. Push this folder to a public GitHub repo.
2. Open **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`.
3. Your tool is live at `https://<you>.github.io/<repo>/`.

## Keeping the leaderboard fresh

The Build League API blocks cross-origin browser reads, so the site ships a snapshot in `data/leaderboard.json`. Refresh it and commit the file:

```bash
python scripts/refresh-leaderboard.py
```

## Limits

- GitHub allows about 60 anonymous API requests per hour per IP. Add a free personal access token (no scopes) in the page to raise this to 5,000.
- The secret scan only looks at the repo root, so it is a heuristic and not a security audit.
- Checks are heuristics. The leaderboard is a snapshot and judges' evaluation is not included. Always re-read the official rules on the hackathon page.

## Tech

Plain HTML, CSS and JavaScript. No framework, no build tools. GitHub's public REST API for repo data.

## License

MIT
