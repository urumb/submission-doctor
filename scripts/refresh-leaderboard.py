"""Refresh data/leaderboard.json from the public BharatCode Build League API.

Run from the project folder:  python scripts/refresh-leaderboard.py
(The API blocks browser cross-origin reads, so the site ships a snapshot instead.)
"""
import json
import urllib.request
from datetime import date

URL = "https://auth.bharatcode.ai/api/hackathon/projects"

req = urllib.request.Request(URL, headers={"User-Agent": "submission-doctor-refresh"})
with urllib.request.urlopen(req, timeout=30) as r:
    projects = json.load(r)

rows = []
for p in projects:
    rows.append({
        "name": (p.get("projectName") or "")[:60],
        "repo": (p.get("repoUrl") or "").replace("https://github.com/", ""),
        "stars": p.get("githubStars") or 0,
        "votes": p.get("websiteVotes") or 0,
        "score": round((p.get("finalScore") or 0), 1),
        "summary_len": len(p.get("summary") or ""),
    })
rows.sort(key=lambda x: x["score"], reverse=True)

lens = sorted(x["summary_len"] for x in rows)
out = {
    "asOf": date.today().isoformat(),
    "count": len(rows),
    "maxStars": max(x["stars"] for x in rows),
    "maxVotes": max(x["votes"] for x in rows),
    "top": [{k: v for k, v in x.items() if k != "summary_len"} for x in rows[:10]],
    "stars": sorted(x["stars"] for x in rows),
    "votes": sorted(x["votes"] for x in rows),
    "scores": sorted(x["score"] for x in rows),
    "medianSummaryChars": lens[len(lens) // 2],
}

with open("data/leaderboard.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"Wrote data/leaderboard.json: {out['count']} projects as of {out['asOf']}")
