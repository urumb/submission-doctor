"use strict";

const $ = (id) => document.getElementById(id);

// Clickjacking guard: never run inside someone else's frame (a framed page could trick users into pasting a key).
try { if (window.top !== window.self) window.top.location = window.self.location; } catch (_) { document.documentElement.hidden = true; }

// Fonts load without blocking first paint (no inline handler, so a strict CSP works).
const fontLink = document.getElementById("fontcss");
if (fontLink) fontLink.media = "all";
const GH = "https://api.github.com";

const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub token"],
  [/sk-[A-Za-z0-9_-]{24,}/, "API secret key (sk-...)"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, "Private key block"],
  [/(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-\/+=]{16,}['"]/i, "Hard-coded credential"],
];

// ---------- persistence for optional AI settings (per-browser convenience only) ----------
function loadSettings() {
  try {
    for (const k of ["base", "model"]) $(k).value = localStorage.getItem("sd_" + k) || "";
    // Secrets are never stored. Remove any saved by earlier versions of this page.
    localStorage.removeItem("sd_key");
    localStorage.removeItem("sd_ghtoken");
  } catch (_) {}
}
function saveSettings() {
  try {
    // Only non-secret settings are saved. The API key and GitHub token stay in memory only:
    // pages under one github.io account share a storage origin, so a stored secret could be read by other pages.
    for (const k of ["base", "model"]) localStorage.setItem("sd_" + k, $(k).value.trim());
  } catch (_) {}
}

function showError(msg) {
  const e = $("err");
  e.textContent = msg || "";
  e.classList.toggle("on", !!msg);
}

// ---------- live deadline countdown ----------
const DEADLINE = new Date("2026-11-10T23:59:00+05:30");
function tickCountdown() {
  const ms = DEADLINE - Date.now();
  const el = $("countdown");
  if (ms <= 0) { el.innerHTML = '<b>Deadline passed</b><span class="d"> · 10 Nov, 11:59 PM IST</span>'; return; }
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  el.innerHTML = `<b>${d}d ${h}h ${m}m left</b><span class="d"> · deadline 10 Nov, 11:59 PM IST</span>`;
}

// ---------- GitHub helpers ----------
function parseRepo(input) {
  const m = input.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
}

function timedFetch(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 10000);
  return fetch(url, { ...(opts || {}), signal: ctl.signal }).finally(() => clearTimeout(t));
}

async function gh(path) {
  let r;
  try {
    r = await timedFetch(GH + path, { headers: ghHeaders() });
  } catch (_) {
    throw new Error("Could not reach GitHub. Check your connection and try again.");
  }
  if (r.status === 403 || r.status === 429) throw new Error("GitHub rate limit hit (60 requests/hour without a token). Add a free token under 'More than 60 checks an hour?' or try again later.");
  return r;
}

function ghHeaders() {
  const h = { Accept: "application/vnd.github+json" };
  const t = $("ghtoken").value.trim();
  if (t) h.Authorization = "Bearer " + t;
  return h;
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// Read a file's text through the GitHub contents API (CORS-safe, no raw.githubusercontent needed).
async function fetchFileText(owner, repo, path) {
  try {
    const r = await timedFetch(`${GH}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, { headers: ghHeaders() });
    if (!r.ok) return "";
    const j = await r.json();
    return j.encoding === "base64" && j.content ? b64ToText(j.content) : "";
  } catch (_) {
    return "";
  }
}

// ---------- analysis ----------
// Short-lived per-tab cache so reloads and shared links do not spend GitHub's 60/hour limit.
async function analyseCached(p, fresh) {
  const key = "sd_c_" + p.owner.toLowerCase() + "/" + p.repo.toLowerCase();
  if (!fresh) {
    try {
      const c = JSON.parse(sessionStorage.getItem(key) || "null");
      if (c && Date.now() - c.t < 10 * 60 * 1000) return c.v;
    } catch (_) {}
  }
  const v = await analyse(p);
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch (_) {}
  return v;
}

async function analyse({ owner, repo }) {
  const metaRes = await gh(`/repos/${owner}/${repo}`);
  if (metaRes.status === 404) throw new Error("Repo not found, or it is private. The hackathon needs it public.");
  if (!metaRes.ok) throw new Error("GitHub returned an error (" + metaRes.status + ").");
  const meta = await metaRes.json();

  // three independent requests, fired together
  const [rootRes, readmeRes, commitsRes] = await Promise.all([
    gh(`/repos/${owner}/${repo}/contents`),
    gh(`/repos/${owner}/${repo}/readme`),
    gh(`/repos/${owner}/${repo}/commits?per_page=10`).catch(() => null),
  ]);
  const root = rootRes.ok ? await rootRes.json() : [];
  const names = Array.isArray(root) ? root.map((f) => f.name) : [];

  let readme = "";
  if (readmeRes.ok) {
    const j = await readmeRes.json();
    readme = j.encoding === "base64" && j.content ? b64ToText(j.content) : "";
  }

  let commitCount = null;
  if (commitsRes && commitsRes.ok) {
    try { commitCount = (await commitsRes.json()).length; } catch (_) {}
  }

  const bcFile = Array.isArray(root) ? root.find((f) => f.name === "BharatCode.txt") : null;
  const bcLooseName = names.find((n) => n.toLowerCase().startsWith("bharatcode") && n !== "BharatCode.txt");
  const bcPromise = bcFile ? fetchFileText(owner, repo, bcFile.name) : Promise.resolve("");

  // secret scan: root files + README, small text files only
  const findings = [];
  for (const n of names) {
    if (/^\.env(\..+)?$/.test(n) && !/example|sample|template/i.test(n)) findings.push(`Committed env file: ${n}`);
  }
  const scanTargets = (Array.isArray(root) ? root : [])
    .filter((f) => f.type === "file" && f.size > 0 && f.size < 100000 && /\.(js|ts|py|json|yml|yaml|env|txt|md|toml|cfg|ini|sh)$/i.test(f.name))
    .slice(0, 10);
  const texts = await Promise.all(scanTargets.map((f) => fetchFileText(owner, repo, f.name).then((t) => [f.name, t])));
  const bcText = await bcPromise;
  texts.push(["README", readme]);
  for (const [name, t] of texts) {
    for (const [re, label] of SECRET_PATTERNS) if (re.test(t)) findings.push(`${label} in ${name}`);
  }

  const lower = readme.toLowerCase();
  const has = (re) => re.test(lower);
  // Demo media only counts if it can actually load: external image/video, or a local file that exists.
  const localRefs = [
    ...[...readme.matchAll(/!\[[^\]]*\]\(\s*<?(?!https?:|data:|\/\/|#)([^)\s>]+)/gi)].map((m) => m[1]),
    ...[...readme.matchAll(/<img[^>]+src=["'](?!https?:|data:|\/\/)([^"']+)/gi)].map((m) => m[1]),
  ].map((p) => p.replace(/^\.\//, "").split(/[?#]/)[0]).filter(Boolean);
  const missingLocal = localRefs.filter((p) => !p.includes("/") && !names.includes(p));
  const externalMedia = /!\[[^\]]*\]\(\s*https?:|<img[^>]+src=["']https?:|youtu\.?be|loom\.com|\.mp4/i.test(readme);
  const workingLocal = localRefs.some((p) => p.includes("/") || names.includes(p));
  const demoOk = externalMedia || workingLocal;

  const checks = [];
  const add = (id, label, status, weight, fix) => checks.push({ id, label, status, weight, fix });

  add("public", "Repo is public", meta.private ? "fail" : "pass", 15, "Make the repository public in Settings → General → Danger Zone.");
  add("bharatcode", "BharatCode.txt is in the repo root", bcFile ? "pass" : "fail", 25,
    bcLooseName ? `Found "${bcLooseName}". The file must be named exactly BharatCode.txt (case-sensitive).` : "Add a file named exactly BharatCode.txt to the repo root.");
  if (bcFile) {
    const placeholder = /\b(todo|placeholder|lorem ipsum|replace this)\b/i.test(bcText);
    const ok = bcText.trim().length > 0 && !placeholder;
    add("bcnonempty", "BharatCode.txt has real content", ok ? "pass" : "warn", 3,
      placeholder ? "BharatCode.txt still contains placeholder text such as TODO. Replace it before you submit." : "Put something useful in it. Check the hackathon page and Discord for the expected format.");
  }
  add("readme", "Has a README", readme ? "pass" : "fail", 10, "Add a README.md. It is the first thing voters and judges read.");
  if (readme) {
    add("pitch", "README explains the problem in the first screen", readme.slice(0, 600).trim().length > 120 ? "pass" : "warn", 7, "Open with one clear sentence on who it helps and what problem it solves.");
    add("install", "README says how to install or run it", has(/install|getting started|quick ?start|npm |pip |docker|usage|how to run/) ? "pass" : "fail", 10, "Add a copy-paste install and run section. If voters cannot run it in under a minute, they will not star it.");
    add("demo", "README has a screenshot, GIF or video", demoOk ? "pass" : "fail", 10,
      missingLocal.length ? `Your README points to ${missingLocal[0]} but that file is not in the repo root, so the image is broken. Add the file and push.` : "Add a demo GIF near the top. This is the single biggest driver of stars.");
    add("bharatmention", "README mentions BharatCode", has(/bharatcode|bharat code/) ? "pass" : "warn", 4, "Say how your project uses the BharatCode API. Judges look for it.");
  }
  add("license", "Has a LICENSE file", names.some((n) => /^licen[sc]e/i.test(n)) ? "pass" : "warn", 4, "Add an open-source license (MIT is the usual choice).");
  add("desc", "Repo description is set", meta.description ? "pass" : "warn", 3, "Add a one-line description in the repo's About box.");
  add("topics", "Repo has topics/tags", (meta.topics || []).length >= 2 ? "pass" : "warn", 2, "Add topics such as bharatcode, hackathon, ai so people can discover it.");
  const liveLink = !!meta.homepage || /https?:\/\/[^\s)]*(github\.io|vercel\.app|netlify\.app|pages\.dev|onrender\.com|streamlit\.app|huggingface\.co\/spaces|railway\.app|fly\.dev)/i.test(readme);
  add("live", "Has a live demo link", liveLink ? "pass" : "warn", 6, "Deploy it (GitHub Pages is free) and add the link to the repo's About box and the README. Voters try things that run in one click.");
  if (readme) add("depth", "README is detailed enough (500+ characters)", readme.trim().length >= 500 ? "pass" : "warn", 3, "Add the problem, features, setup and how it uses BharatCode.");
  if (commitCount !== null) add("commits", "Commit history shows real work (3+ commits)", commitCount >= 3 ? "pass" : "warn", 2, "One giant commit looks rushed. Commit as you build, with clear messages.");
  add("secrets", "No obvious secrets committed", findings.length ? "fail" : "pass", 15,
    findings.length ? "Remove and ROTATE these immediately: " + [...new Set(findings)].join("; ") : "");

  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.status === "pass" ? c.weight : c.status === "warn" ? c.weight * 0.5 : 0), 0);
  const score = Math.round((got / total) * 100);

  return { meta, checks, score, readme };
}

function verdictFor(score, checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const lines = {
    bharatcode: "No BharatCode.txt. The one file the hackathon asked for. Bold strategy.",
    demo: "No demo GIF. Voters will not read a wall of text, they will leave.",
    install: "Nobody can tell how to run it. Even you might forget by Monday.",
    secrets: "There is a secret in the repo. Rotate it first, panic second.",
    readme: "No README. The repo is basically a locked door.",
    public: "The repo is private. The judges cannot see it, and neither can the voters.",
  };
  const roast = (failed.find((c) => lines[c.id]) || {}).id;
  const roastLine = roast ? lines[roast] : "Nothing embarrassing found. Suspicious, but we will allow it.";
  let verdict;
  if (score >= 90) verdict = "Submission-ready";
  else if (score >= 70) verdict = "Almost there";
  else if (score >= 45) verdict = "Needs work";
  else verdict = "Critical condition";
  return { verdict, roastLine };
}

// ---------- optional AI text (OpenAI-compatible endpoint, user supplied) ----------
function templateSummary(meta, checks) {
  const name = meta.name;
  const desc = (meta.description || "an AI-powered project built on the BharatCode API").trim().replace(/[.!?\s]+$/, "");
  return {
    summary: `${name} is ${desc}. It is open source, runs with a quick setup, and was built for the BharatCode Build League. Try it, star the repo and vote if it helps you.`,
    post: `I just built ${name} for the BharatCode Build League: ${desc}.\n\nRepo: ${meta.html_url}\n\nIf it is useful, a star on GitHub and a vote on the hackathon page would mean a lot. #BharatCode #BuildLeague`,
  };
}

// ---------- rendering ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function scoreColor(s) {
  return s >= 90 ? "#7fc99a" : s >= 70 ? "#e6b655" : "#ef7a64";
}

function badgeSvg(score) {
  const color = scoreColor(score);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="20" role="img" aria-label="submission readiness: ${score}%"><rect width="120" height="20" fill="#555"/><rect x="120" width="70" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="8" y="14">submission-ready</text><text x="128" y="14">${score}%</text></g></svg>`;
}

function drawCard(meta, score, verdict, roastLine) {
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 630;
  const x = c.getContext("2d");
  x.fillStyle = "#16110d"; x.fillRect(0, 0, 1200, 630);
  const g = x.createRadialGradient(980, 120, 20, 980, 120, 520);
  g.addColorStop(0, "rgba(224,169,109,.28)"); g.addColorStop(1, "rgba(224,169,109,0)");
  x.fillStyle = g; x.fillRect(0, 0, 1200, 630);
  x.fillStyle = "#e0a96d"; x.font = "bold 34px system-ui,sans-serif"; x.fillText("SUBMISSION DOCTOR", 60, 80);
  x.fillStyle = "#f4ede2"; x.font = "bold 54px system-ui,sans-serif";
  const title = meta.full_name.length > 34 ? meta.full_name.slice(0, 33) + "…" : meta.full_name;
  x.fillText(title, 60, 170);
  x.fillStyle = scoreColor(score); x.font = "bold 220px system-ui,sans-serif"; x.fillText(score + "%", 60, 400);
  x.fillStyle = "#f4ede2"; x.font = "bold 46px system-ui,sans-serif"; x.fillText(verdict, 60, 470);
  x.fillStyle = "#b5a592"; x.font = "italic 28px system-ui,sans-serif";
  const words = roastLine.split(" "); let line = ""; let y = 530;
  for (const w of words) {
    if (x.measureText(line + w).width > 1080) { x.fillText(line, 60, y); line = ""; y += 36; }
    line += w + " ";
  }
  x.fillText(line, 60, y);
  return c;
}

function render(res, ai) {
  const { meta, checks, score } = res;
  const { verdict, roastLine } = verdictFor(score, checks);
  const mark = { pass: "✓", fail: "✕", warn: "!" };
  const items = checks
    .map((c) => `<li><span class="mark ${c.status}">${mark[c.status]}</span><div><div>${esc(c.label)}</div>${c.status !== "pass" && c.fix ? `<div class="fix">${esc(c.fix)}</div>` : ""}</div></li>`)
    .join("");
  const badgeColor = score >= 90 ? "2f8f4e" : score >= 70 ? "b98a12" : "c8402f";
  const badgeMd = `![submission readiness](https://img.shields.io/badge/submission--ready-${score}%25-${badgeColor})`;
  $("out").innerHTML = `
    <div class="card">
      <div class="scorebox">
        <div class="ring" style="--p:${score};--c:${scoreColor(score)}"><span>${score}%</span></div>
        <div><div class="verdict">${esc(verdict)}</div><div class="repo">${esc(meta.full_name)}</div><div class="roast">${esc(roastLine)}</div></div>
      </div>
      <div class="row">
        <button class="btn small" id="dlcard" type="button">Download score card <span class="ico">↓</span></button>
        <button class="btn small outline" id="cpbadge" type="button">Copy README badge <span class="ico">⧉</span></button>
        <button class="btn small outline" id="share" type="button">Copy share link <span class="ico">⧉</span></button>
      </div>
    </div>
    ${aiCard()}
    <div class="card"><h3>Checklist</h3><ul class="checks">${items}</ul></div>
    <div class="card"><h3>Project summary <span class="fix">(paste into the submission form)</span></h3><pre id="sum">${esc(ai.summary)}</pre>
      <h3 style="margin-top:20px">Launch post</h3><pre id="post">${esc(ai.post)}</pre>
      <div class="row"><button class="btn small outline" id="cpsum" type="button">Copy summary <span class="ico">⧉</span></button><button class="btn small outline" id="cppost" type="button">Copy post <span class="ico">⧉</span></button></div>
      ${ai.source === "template" ? '<p class="fix">Built-in template. Run the AI review above for model-written text.</p>' : ""}</div>
    ${leaderboardCard(meta)}
    ${fixKit(meta, checks)}`;
  $("result").classList.add("on");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });

  const copy = (t, btn) => {
    const label = btn.firstChild.textContent;
    const done = () => { btn.firstChild.textContent = "Copied "; setTimeout(() => (btn.firstChild.textContent = label), 1300); };
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(done).catch(() => {
      const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
      ta.remove();
    });
  };
  $("cpbadge").onclick = (e) => copy(badgeMd, e.currentTarget);
  $("cpsum").onclick = (e) => copy(ai.summary, e.currentTarget);
  $("cppost").onclick = (e) => copy(ai.post, e.currentTarget);
  $("dlcard").onclick = () => {
    const c = drawCard(meta, score, verdict, roastLine);
    const a = document.createElement("a");
    a.download = meta.name + "-submission-doctor.png";
    a.href = c.toDataURL("image/png");
    a.click();
  };
  bindExtras(meta);
  bindAi();
}


// ---------- leaderboard snapshot ----------
let LB = null;
async function loadLB() {
  if (LB) return LB;
  try {
    const r = await timedFetch("data/leaderboard.json", {}, 6000);
    if (r.ok) LB = await r.json();
  } catch (_) {}
  return LB;
}

function lbEstimate(stars, votes) {
  const a = Math.min(100, (stars / LB.maxStars) * 100);
  const b = Math.min(100, (votes / LB.maxVotes) * 100);
  const score = (a + b) / 2;
  const rank = LB.scores.filter((x) => x > score).length + 1;
  return { score, rank };
}

function leaderboardCard(meta) {
  if (!LB) return "";
  const stars = Number(meta.stargazers_count) || 0;
  const perVote = (50 / LB.maxVotes).toFixed(1);
  const perStar = (50 / LB.maxStars).toFixed(1);
  const cutoff10 = LB.top[LB.top.length - 1].score;
  const top = LB.top.slice(0, 5).map((t, i) => `<li><span class="n">${i + 1}</span><span class="nm">${esc(t.name)}</span><span class="st">${t.stars}★ · ${t.votes} votes · ${t.score}</span></li>`).join("");
  const zeroStars = LB.stars.filter((x) => x === 0).length;
  return `<div class="card" id="lb"><h3>Where you'd rank <span class="fix">(snapshot ${esc(LB.asOf)} · ${LB.count} projects)</span></h3>
    <p class="fix">Score is half GitHub stars and half website votes, each measured against the current leader (${LB.maxStars} stars, ${LB.maxVotes} votes). So <b>one vote is worth about ${perVote} points and one star about ${perStar}</b>. ${zeroStars} of ${LB.count} projects still have zero stars, and the top 10 starts at ${cutoff10} points.</p>
    <div class="whatif"><div><label for="wi-stars">Your stars</label><input type="number" min="0" id="wi-stars" value="${stars}"></div>
      <div><label for="wi-votes">Votes you could get</label><input type="number" min="0" id="wi-votes" value="10"></div>
      <div class="res" id="wi-res"></div></div>
    <ul class="top5">${top}</ul>
    <p class="fix">Weights and maxima come from the public leaderboard and change as projects gain votes. Judges' evaluation is separate and not included.</p></div>`;
}

function fixKit(meta, checks) {
  const name = meta.name;
  const desc = (meta.description || "One line on who this helps and what problem it solves.").trim();
  const readme = `# ${name}

> ${desc}

![demo](demo.gif)

## The problem
Who has this problem, and why does it matter?

## What it does
- Feature one
- Feature two
- Feature three

## Quick start
\`\`\`bash
git clone ${meta.html_url}.git
cd ${name}
# install and run steps here
\`\`\`

## How it uses BharatCode
Explain which BharatCode model you call, and what it does for the user.

## Tech stack
List the main tools and libraries.

## License
MIT
`;
  const bc = `Project: ${name}
Repo: ${meta.html_url}
Uses the BharatCode API for: (describe what the model does in your project)
NOTE: confirm the exact BharatCode.txt format with the BharatCode team before submitting.
`;
  const ign = `# secrets: never commit these
.env
.env.*
!.env.example
*.pem
*.key

# dependencies and build output
node_modules/
__pycache__/
dist/
build/
.DS_Store
`;
  const envEx = `# Copy to .env and fill in. Never commit the real .env.
BHARATCODE_API_KEY=
BHARATCODE_BASE_URL=
BHARATCODE_MODEL=
`;
  window.__kit = { readme, bc, ign, envEx };
  const need = (id) => checks.some((c) => c.id === id && c.status !== "pass");
  const rows = [
    ["README.md template", "kit-readme", need("readme") || need("pitch") || need("install") || need("demo"), readme],
    ["BharatCode.txt starter", "kit-bc", need("bharatcode"), bc],
    [".gitignore", "kit-ign", need("secrets"), ign],
    [".env.example", "kit-env", need("secrets"), envEx],
  ];
  const html = rows.map(([label, id, hot, text]) => `<details class="kit"><summary>${label}${hot ? ' <span class="badge">suggested</span>' : ""}</summary><pre>${esc(text)}</pre>
    <div class="row"><button class="btn small outline" data-kit="${id}" type="button">Copy ${esc(label)} <span class="ico">⧉</span></button></div></details>`).join("");
  return `<div class="card"><h3>Fix-it kit</h3><p class="fix">Ready-to-paste files for what your check found missing. Edit them before you commit.</p>${html}</div>`;
}

function bindExtras(meta) {
  const kit = window.__kit || {};
  const map = { "kit-readme": kit.readme, "kit-bc": kit.bc, "kit-ign": kit.ign, "kit-env": kit.envEx };
  document.querySelectorAll("[data-kit]").forEach((b) => {
    b.onclick = (e) => copyText(map[b.dataset.kit] || "", e.currentTarget);
  });
  const share = $("share");
  if (share) share.onclick = (e) => copyText(shareUrl(meta.full_name), e.currentTarget);
  if (LB && $("wi-res")) {
    const upd = () => {
      const st = Math.max(0, parseInt($("wi-stars").value, 10) || 0);
      const vt = Math.max(0, parseInt($("wi-votes").value, 10) || 0);
      const { score, rank } = lbEstimate(st, vt);
      $("wi-res").innerHTML = `<b>${score.toFixed(1)}</b> points · about rank <b>#${rank}</b> of ${LB.count}`;
    };
    $("wi-stars").oninput = upd; $("wi-votes").oninput = upd; upd();
  }
}

function shareUrl(fullName) {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("repo", fullName);
  return u.toString();
}

function copyText(t, btn) {
  const label = btn.firstChild.textContent;
  const done = () => { btn.firstChild.textContent = "Copied "; setTimeout(() => (btn.firstChild.textContent = label), 1300); };
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(done).catch(() => {
    const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (_) {}
    ta.remove();
  });
}


// ---------- AI review (user-supplied OpenAI-compatible endpoint) ----------
let LAST = null;

function aiConfig() {
  const base = $("base").value.trim().replace(/\/+$/, "");
  const key = $("key").value.trim();
  const model = $("model").value.trim();
  return base && key && model ? { base, key, model } : null;
}

// The key is only ever sent over HTTPS (or to a local test server), and never to a URL with embedded credentials.
function endpointProblem(base) {
  let u;
  try { u = new URL(base); } catch (_) { return "The base URL is not a valid web address."; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "For your key's safety the base URL must start with https://";
  if (u.username || u.password) return "Remove the username and password from the base URL.";
  return "";
}

function friendly(err) {
  if (err && err.name === "AbortError") return "The request timed out. Try again.";
  const m = String((err && err.message) || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Could not reach the endpoint. Check the base URL, or the API may block browser calls (CORS).";
  if (/HTTP 401|HTTP 403/.test(m)) return "The key was rejected (" + m.slice(0, 60) + "). Check the API key.";
  if (/HTTP 402/.test(m)) return "Your key works, but this account has no API access yet. BharatCode needs a Lite or Pro plan, or a verified student account (college email). Details: " + m.replace(/^HTTP 402:\s*/, "").slice(0, 220);
  if (/HTTP 503/.test(m)) return "BharatCode says the model is unavailable right now (503). It may be busy, or the model name may not be offered. Try again in a minute, or check the model name (for example qwen-3.8-27b).";
  if (/HTTP 429/.test(m)) return "Too many requests right now (429). Wait a moment and try again.";
  if (/HTTP 404/.test(m)) return "Not found (" + m.slice(0, 120) + "). Check the base URL and model name.";
  return m;
}

async function callModel(cfg, messages, ms) {
  const problem = endpointProblem(cfg.base);
  if (problem) throw new Error(problem);
  const r = await timedFetch(cfg.base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.6 }),
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    redirect: "error", // a redirect could forward the key to another host
  }, ms || 90000);
  if (!r.ok) {
    let d = "";
    try { d = (await r.text()).slice(0, 200); } catch (_) {}
    d = d.split(cfg.key).join("[hidden]"); // never echo the key back into the page
    throw new Error("HTTP " + r.status + (d ? ": " + d : ""));
  }
  const j = await r.json();
  const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!t) throw new Error("The model returned an empty response.");
  return t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function aiCard() {
  const on = !!aiConfig();
  return `<div class="card" id="aicard"><h3>AI review <span class="badge">BharatCode</span></h3>
    <p class="fix">Reads your README and results, tells you what to fix first for the most stars and votes, and writes your submission text.${on ? "" : " It needs your BharatCode API key, and the button will take you to where you add it."}</p>
    <div class="row"><button class="btn small" id="ai-run" type="button">Run AI review <span class="ico">→</span></button></div>
    <div id="ai-out"></div></div>`;
}

function bindAi() {
  const btn = $("ai-run");
  if (!btn) return;
  btn.onclick = runAiReview;
}

// No key yet: open the "Optional AI" panel, scroll to it and focus the first empty field.
function goToKeySetup() {
  const d = document.querySelector("#ai details");
  if (d) d.open = true;
  const target = ["base", "model", "key"].map($).find((el) => !el.value.trim()) || $("key");
  const back = $("backres");
  if (back && LAST) back.hidden = false;
  $("testres").textContent = "Add your base URL, model and key, click Test connection, then use “Back to my results” and click Run AI review.";
  $("ai").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => target.focus({ preventScroll: true }), 450);
}

async function runAiReview() {
  const cfg = aiConfig();
  const out = $("ai-out");
  if (!cfg) { goToKeySetup(); return; }
  if (!LAST) return;
  const btn = $("ai-run");
  btn.disabled = true;
  out.innerHTML = '<p class="fix">Reviewing your repo with the model. This can take up to a minute.</p>';
  const { meta, checks, score, readme } = LAST;
  const checkLines = checks.map((c) => `- [${c.status.toUpperCase()}] ${c.label}`).join("\n");
  const prompt = `You are a blunt but kind reviewer helping a developer win the BharatCode Build League hackathon. Ranking is half GitHub stars and half website votes, then judges' evaluation. Judges read the repo summary and README.

Repo: ${meta.full_name}
Description: ${meta.description || "(none)"}
Stars: ${meta.stargazers_count}
Readiness score from automated checks: ${score}/100
Checks:
${checkLines}

README (may be truncated):
${readme ? readme.slice(0, 3500) : "(no README)"}

Respond in plain text using exactly these five headings, each on its own line starting with "## ":
## Verdict
Two sentences: what is strong, what is weak.
## Fix first
A numbered list of the 3 changes that will earn the most stars and votes, most important first. Be specific to this repo.
## README intro
A rewritten opening paragraph (under 120 words) that states who it helps and the problem it solves.
## Submission summary
A punchy summary under 900 characters for the hackathon form. Mention how it uses the BharatCode API only if the README says it does.
## Launch post
A short LinkedIn or X post asking for a GitHub star and a vote. No hashtag spam.`;
  try {
    const text = await callModel(cfg, [{ role: "user", content: prompt }], 120000);
    const parts = text.split(/^##\s+/m).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) {
      out.innerHTML = `<pre>${esc(text)}</pre>`;
    } else {
      out.innerHTML = parts.map((p, i) => {
        const nl = p.indexOf("\n");
        const title = nl === -1 ? p : p.slice(0, nl).trim();
        const body = nl === -1 ? "" : p.slice(nl + 1).trim();
        return `<h3 style="margin-top:18px">${esc(title)}</h3><pre>${esc(body)}</pre><div class="row"><button class="btn small outline" data-ai="${i}" type="button">Copy <span class="ico">⧉</span></button></div>`;
      }).join("");
      out.querySelectorAll("[data-ai]").forEach((b) => {
        const body = parts[+b.dataset.ai];
        const nl = body.indexOf("\n");
        b.onclick = (e) => copyText(nl === -1 ? body : body.slice(nl + 1).trim(), e.currentTarget);
      });
    }
  } catch (err) {
    out.innerHTML = `<p class="err on">AI review failed: ${esc(friendly(err))}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- main ----------
async function run(input, fresh) {
  showError("");
  $("result").classList.remove("on");
  const parsed = parseRepo(input);
  if (!parsed) { showError("Enter a link like https://github.com/owner/repo"); return; }
  saveSettings();
  $("go").disabled = true; $("gotext").textContent = "Examining…";
  try {
    const res = await analyseCached(parsed, fresh);
    LAST = res;
    await loadLB();
    try { history.replaceState(null, "", shareUrl(res.meta.full_name)); } catch (_) {}
    const ai = { ...templateSummary(res.meta, res.checks), source: "template" };
    render(res, ai);
  } catch (err) {
    showError(err.message);
  } finally {
    $("go").disabled = false; $("gotext").textContent = "Diagnose";
  }
}

$("f").addEventListener("submit", (e) => { e.preventDefault(); run($("url").value, true); });
// Bundled real snapshot: instant, and costs no GitHub API requests.
async function loadExample() {
  showError("");
  $("result").classList.remove("on");
  try {
    const r = await timedFetch("data/example.json", {}, 6000);
    if (!r.ok) throw new Error("missing");
    const ex = await r.json();
    await loadLB();
    $("url").value = ex.meta.html_url;
    LAST = { meta: ex.meta, checks: ex.checks, score: ex.score, readme: ex.readme };
    render(LAST, { ...templateSummary(ex.meta, ex.checks), source: "template" });
    $("out").insertAdjacentHTML("afterbegin", `<p class="fix">Example report: a snapshot of this project's own repo taken ${esc(ex.asOf)}. Paste your repo above for live results.</p>`);
  } catch (_) {
    showError("Could not load the example. Check your connection and try again.");
  }
}
$("demo").addEventListener("click", loadExample);

loadSettings();
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get("example")) { loadExample(); return; }
  const q = params.get("repo");
  if (q && /^[^/\s]+\/[^/\s]+$/.test(q)) {
    $("url").value = "https://github.com/" + q;
    run($("url").value);
  }
})();

$("test").onclick = async () => {
  saveSettings();
  const cfg = aiConfig();
  const out = $("testres");
  if (!cfg) { out.textContent = "Fill in the base URL, model name and key first."; return; }
  out.textContent = "Testing…";
  $("test").disabled = true;
  try {
    const t = await callModel(cfg, [{ role: "user", content: "Reply with the single word OK." }], 30000);
    out.textContent = "Connected. The model replied: " + t.slice(0, 40);
  } catch (e) {
    out.textContent = "Failed: " + friendly(e);
  } finally {
    $("test").disabled = false;
  }
};
$("forget").onclick = () => {
  $("key").value = "";
  $("ghtoken").value = "";
  $("testres").textContent = "Cleared. Nothing was stored, so there is nothing else to remove.";
};
$("backres").onclick = () => {
  const t = $("aicard") || $("result");
  if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
};

tickCountdown();
setInterval(tickCountdown, 30000);
