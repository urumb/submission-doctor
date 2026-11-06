# Submission Doctor

Paste your GitHub repo and get a brutally honest hackathon-readiness check, a share-ready score card and a README badge. Built for the BharatCode Build League. Runs entirely in your browser, so it is free to use and free to host.

## What it checks

- Repo is public
- `BharatCode.txt` exists in the repo root (exact name)
- README exists, explains the problem, shows how to run it, has a demo GIF or screenshot and mentions BharatCode
- LICENSE, repo description and topics
- Obvious committed secrets (API keys, tokens, `.env` files)

Then it gives you a score out of 100, a one-line roast, a downloadable score card, a README badge, and a project summary plus launch post you can paste into the submission form.

## Run it

No build step. Serve the folder with any static server:

```bash
python -m http.server 8765
```

Open http://localhost:8765, paste a repo link and click **Diagnose**.

To host it for free, push this folder to GitHub and enable GitHub Pages.

## Optional AI-written text

Open "Optional: AI-written summary and launch post", then enter an OpenAI-compatible base URL, a model name and your API key. The key stays in your browser and is only sent to the endpoint you enter. With nothing entered, built-in templates are used.

## Deploy free on GitHub Pages

1. Push this folder to a public GitHub repo.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`.
3. Your tool is live at `https://<you>.github.io/<repo>/`.

## Add your demo GIF

Record a short screen capture of a check running, save it as `demo.gif` in this folder, and put `![demo](demo.gif)` at the top of this README. Voters star what they can see working in five seconds.

## Limits

- GitHub allows about 60 unauthenticated API requests per hour per IP. Add a free personal access token (no scopes) in the page to raise this to 5,000.
- The secret scan only looks at the repo root, so it is a heuristic, not a security audit.
- Checks are heuristics. Always re-read the official rules on the hackathon page.

## License

MIT
