#!/bin/bash
# Ежедневная докачка Google (06.11.2026): скрытые ролики YouTube → Storage (Gemini читает только копию),
# затем прокладка Google → коды для новых креативов. Запускается LaunchAgent com.example.google-daily в 09:15,
# после кронов Vercel google/sync (07:30) и crm-sync (08:30). Логи: ~/Library/Logs/google-daily.log
set -uo pipefail
cd "$(dirname "$0")/.."
echo "=== $(date '+%Y-%m-%d %H:%M') google-daily ==="
# YouTube регулярно ломает старые версии yt-dlp — держим свежим (если уже свежий, это секунды)
brew upgrade yt-dlp >/dev/null 2>&1 || true
python3 scripts/google-video-backfill.py --min 0 || echo "!! backfill упал (код $?)"
set -a; source .env.local; set +a
npx --yes tsx scripts/google-automap.ts 0 400 || echo "!! automap упал (код $?)"
echo "=== готово $(date '+%H:%M') ==="
