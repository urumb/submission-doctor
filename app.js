"use strict";

const $ = (id) => document.getElementById(id);
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
    for (const k of ["base", "model", "key", "ghtoken"]) $(k).value = localStorage.getItem("sd_" + k) || "";
  } catch (_) {}
}
function saveSettings() {
  try {
    for (const k of ["base", "model", "key", "ghtoken"]) localStorage.setItem("sd_" + k, $(k).value.trim());
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
  if (ms <= 0) { el.innerHTML = "<b>Deadline passed</b> · 10 Nov, 11:59 PM IST"; return; }
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  el.innerHTML = `<b>${d}d ${h}h ${m}m left</b> · deadline 10 Nov, 11:59 PM IST`;
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
async function analyse({ owner, repo }) {
  const metaRes = await gh(`/repos/${owner}/${repo}`);
  if (metaRes.status === 404) throw new Error("Repo not found, or it is private. The hackathon needs it public.");
  if (!metaRes.ok) throw new Error("GitHub returned an error (" + metaRes.status + ").");
  const meta = await metaRes.json();

  const rootRes = await gh(`/repos/${owner}/${repo}/contents`);
  const root = rootRes.ok ? await rootRes.json() : [];
  const names = Array.isArray(root) ? root.map((f) => f.name) : [];

  const readmeRes = await gh(`/repos/${owner}/${repo}/readme`);
  let readme = "";
  if (readmeRes.ok) {
    const j = await readmeRes.json();
    readme = j.encoding === "base64" && j.content ? b64ToText(j.content) : "";
  }

  const bcFile = Array.isArray(root) ? root.find((f) => f.name === "BharatCode.txt") : null;
  const bcLooseName = names.find((n) => n.toLowerCase().startsWith("bharatcode") && n !== "BharatCode.txt");
  const bcText = bcFile ? await fetchFileText(owner, repo, bcFile.name) : "";

  // secret scan: root files + README, small text files only
  const findings = [];
  for (const n of names) {
    if (/^\.env(\..+)?$/.test(n) && !/example|sample|template/i.test(n)) findings.push(`Committed env file: ${n}`);
  }
  const scanTargets = (Array.isArray(root) ? root : [])
    .filter((f) => f.type === "file" && f.size > 0 && f.size < 100000 && /\.(js|ts|py|json|yml|yaml|env|txt|md|toml|cfg|ini|sh)$/i.test(f.name))
    .slice(0, 10);
  const texts = await Promise.all(scanTargets.map((f) => fetchFileText(owner, repo, f.name).then((t) => [f.name, t])));
  texts.push(["README", readme]);
  for (const [name, t] of texts) {
    for (const [re, label] of SECRET_PATTERNS) if (re.test(t)) findings.push(`${label} in ${name}`);
  }

  const lower = readme.toLowerCase();
  const has = (re) => re.test(lower);
  const imgOrVideo = /!\[[^\]]*\]\([^)]+\)|<img |\.gif|\.mp4|youtu\.?be|loom\.com/i.test(readme);

  const checks = [];
  const add = (id, label, status, weight, fix) => checks.push({ id, label, status, weight, fix });

  add("public", "Repo is public", meta.private ? "fail" : "pass", 15, "Make the repository public in Settings → General → Danger Zone.");
  add("bharatcode", "BharatCode.txt is in the repo root", bcFile ? "pass" : "fail", 25,
    bcLooseName ? `Found "${bcLooseName}". The file must be named exactly BharatCode.txt (case-sensitive).` : "Add a file named exactly BharatCode.txt to the repo root.");
  if (bcFile) add("bcnonempty", "BharatCode.txt is not empty", bcText.trim().length > 0 ? "pass" : "warn", 3, "Put something useful in it. Check the hackathon page and Discord for the expected format.");
  add("readme", "Has a README", readme ? "pass" : "fail", 10, "Add a README.md. It is the first thing voters and judges read.");
  if (readme) {
    add("pitch", "README explains the problem in the first screen", readme.slice(0, 600).trim().length > 120 ? "pass" : "warn", 7, "Open with one clear sentence on who it helps and what problem it solves.");
    add("install", "README says how to install or run it", has(/install|getting started|quick ?start|npm |pip |docker|usage|how to run/) ? "pass" : "fail", 10, "Add a copy-paste install and run section. If voters cannot run it in under a minute, they will not star it.");
    add("demo", "README has a screenshot, GIF or video", imgOrVideo ? "pass" : "fail", 10, "Add a demo GIF near the top. This is the single biggest driver of stars.");
    add("bharatmention", "README mentions BharatCode", has(/bharatcode|bharat code/) ? "pass" : "warn", 4, "Say how your project uses the BharatCode API. Judges look for it.");
  }
  add("license", "Has a LICENSE file", names.some((n) => /^licen[sc]e/i.test(n)) ? "pass" : "warn", 4, "Add an open-source license (MIT is the usual choice).");
  add("desc", "Repo description is set", meta.description ? "pass" : "warn", 3, "Add a one-line description in the repo's About box.");
  add("topics", "Repo has topics/tags", (meta.topics || []).length >= 2 ? "pass" : "warn", 2, "Add topics such as bharatcode, hackathon, ai so people can discover it.");
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

async function aiText(meta, readme) {
  const base = $("base").value.trim().replace(/\/+$/, "");
  const key = $("key").value.trim();
  const model = $("model").value.trim();
  if (!base || !key || !model) return null;
  const prompt = `Repo: ${meta.full_name}\nDescription: ${meta.description || "(none)"}\nREADME excerpt:\n${readme.slice(0, 2500)}\n\nWrite (1) a punchy hackathon project summary under 900 characters, then a line containing only ---, then (2) a short LinkedIn/X launch post asking for a GitHub star and a vote. No hashtags spam. Plain text.`;
  const r = await timedFetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7 }),
  }, 45000);
  if (!r.ok) throw new Error("AI endpoint returned " + r.status);
  const j = await r.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error("AI endpoint returned no text");
  const [a, b] = text.split(/\n-{3,}\n/);
  return { summary: (a || "").trim(), post: (b || "").trim() };
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
      </div>
    </div>
    <div class="card"><h3>Checklist</h3><ul class="checks">${items}</ul></div>
    <div class="card"><h3>Project summary <span class="fix">(paste into the submission form)</span></h3><pre id="sum">${esc(ai.summary)}</pre>
      <h3 style="margin-top:20px">Launch post</h3><pre id="post">${esc(ai.post)}</pre>
      <div class="row"><button class="btn small outline" id="cpsum" type="button">Copy summary <span class="ico">⧉</span></button><button class="btn small outline" id="cppost" type="button">Copy post <span class="ico">⧉</span></button></div>
      ${ai.source === "template" ? '<p class="fix">Built-in template used. Add an API endpoint and key under "Optional AI" for AI-written text.</p>' : ""}</div>`;
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
}

// ---------- main ----------
async function run(input) {
  showError("");
  $("result").classList.remove("on");
  const parsed = parseRepo(input);
  if (!parsed) { showError("Enter a link like https://github.com/owner/repo"); return; }
  saveSettings();
  $("go").disabled = true; $("gotext").textContent = "Examining…";
  try {
    const res = await analyse(parsed);
    let ai = { ...templateSummary(res.meta, res.checks), source: "template" };
    try {
      const real = await aiText(res.meta, res.readme);
      if (real && real.summary) ai = { summary: real.summary, post: real.post || ai.post, source: "ai" };
    } catch (err) {
      showError("AI text failed (" + err.message + "), showing the template instead.");
    }
    render(res, ai);
  } catch (err) {
    showError(err.message);
  } finally {
    $("go").disabled = false; $("gotext").textContent = "Diagnose";
  }
}

$("f").addEventListener("submit", (e) => { e.preventDefault(); run($("url").value); });
$("demo").addEventListener("click", () => { $("url").value = "https://github.com/octocat/Hello-World"; run($("url").value); });

loadSettings();
tickCountdown();
setInterval(tickCountdown, 30000);
