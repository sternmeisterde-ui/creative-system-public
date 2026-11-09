#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Скачивает рекламные YouTube-ролики Google Ads (unlisted — Gemini по ссылке их не читает, 403)
и кладёт в Supabase Storage (бакет creatives, папка google/), прописывая ссылку в
meta_creatives.asset_url (platform='google'). После этого /api/gemini/batch разбирает их
как обычное видео. /api/google/sync ссылку при пересинке сохраняет.

Запуск из корня creative-system (нужны yt-dlp + .env.local):
    python3 scripts/google-video-backfill.py            # ролики со спендом ≥ 50 €
    python3 scripts/google-video-backfill.py --min 0    # все
    python3 scripts/google-video-backfill.py --ids 111111111111,222222222222
"""
import os, sys, json, subprocess, urllib.request, urllib.parse, argparse, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def load_env():
    p = os.path.join(ROOT, ".env.local")
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))
load_env()
U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": "Bearer " + K}
BUCKET = "creatives"

def rest(path, method="GET", body=None, extra=None):
    req = urllib.request.Request(U + "/rest/v1/" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=H | {"Content-Type": "application/json"} | (extra or {}))
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else None

def fetch_all(path):
    out, off = [], 0
    while True:
        chunk = rest(path, extra={"Range": f"{off}-{off+999}", "Range-Unit": "items"})
        out += chunk
        if len(chunk) < 1000: return out
        off += 1000

def upload(local, key, mime):
    data = open(local, "rb").read()
    req = urllib.request.Request(f"{U}/storage/v1/object/{BUCKET}/{key}", method="POST", data=data,
                                 headers=H | {"Content-Type": mime, "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=600) as r: r.read()
    return f"{U}/storage/v1/object/public/{BUCKET}/{key}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=float, default=50.0, help="минимальный lifetime-спенд крео, €")
    ap.add_argument("--ids", default="", help="список asset id через запятую (игнорирует --min)")
    ap.add_argument("--force", action="store_true", help="перекачать даже если файл уже в Storage")
    a = ap.parse_args()

    cre = fetch_all("meta_creatives?platform=eq.google&object_type=eq.VIDEO&select=ad_id,ad_name,video_id,asset_url")
    spend = {r["ad_id"]: r["spend"] for r in fetch_all("meta_ads?platform=eq.google&select=ad_id,spend")}
    want = set(x.strip() for x in a.ids.split(",") if x.strip())
    todo = []
    for c in cre:
        aid = c["ad_id"].split(":")[-1]
        if want and aid not in want: continue
        if not want and (spend.get(c["ad_id"], 0) < a.min): continue
        if not a.force and "/storage/v1/" in (c["asset_url"] or ""): continue
        todo.append((spend.get(c["ad_id"], 0), c))
    todo.sort(key=lambda x: -x[0])
    print(f"роликов к скачиванию: {len(todo)} (из {len(cre)} google-видео)")

    ok = fail = 0
    with tempfile.TemporaryDirectory() as tmp:
        for sp, c in todo:
            aid = c["ad_id"].split(":")[-1]; vid = c["video_id"]
            out = os.path.join(tmp, f"{aid}.mp4")
            t0 = time.time()
            # web-клиент YouTube отдаёт 403 на часть роликов — android-клиент качает; yt-dlp держать свежим (brew upgrade yt-dlp)
            r = subprocess.run(["yt-dlp", "-q", "--no-warnings", "-f", "b[height<=720][ext=mp4]/bv*[height<=720][ext=mp4]+ba[ext=m4a]/b",
                                "--extractor-args", "youtube:player_client=android,web",
                                "--merge-output-format", "mp4", "-o", out, f"https://www.youtube.com/watch?v={vid}"],
                               capture_output=True, text=True)
            if r.returncode != 0 or not os.path.exists(out):
                fail += 1; print(f"  ✕ {aid} {vid} {sp:.0f}€ — yt-dlp: {r.stderr.strip()[-200:]}"); continue
            size = os.path.getsize(out) / 1e6
            if size > 200:
                fail += 1; print(f"  ✕ {aid} {vid} — {size:.0f} MB > лимита Storage"); os.remove(out); continue
            try:
                url = upload(out, f"google/{aid}.mp4", "video/mp4")
                rest(f"meta_creatives?ad_id=eq.{urllib.parse.quote(c['ad_id'])}", "PATCH", {"asset_url": url}, {"Prefer": "return=minimal"})
                ok += 1; print(f"  ✓ {aid} {vid} {sp:.0f}€ {size:.1f} MB {time.time()-t0:.0f}s")
            except Exception as e:
                fail += 1; print(f"  ✕ {aid} upload: {str(e)[:200]}")
            finally:
                if os.path.exists(out): os.remove(out)
    print(f"готово: скачано {ok}, ошибок {fail}")

if __name__ == "__main__":
    main()
