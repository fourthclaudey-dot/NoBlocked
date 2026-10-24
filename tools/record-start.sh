#!/usr/bin/env bash
# Records a cold start of Kettu and splits it into frames: tools/record-start.sh <name>
set -e
export MSYS_NO_PATHCONV=1 # keep /sdcard paths as-is under Git Bash
name=${1:-start}
out="logs/rec-$name"
ffmpeg="${FFMPEG:-ffmpeg}"
mkdir -p "$out"
"$ADB" shell rm -f /sdcard/kb-rec.mp4
"$ADB" shell screenrecord --time-limit 12 /sdcard/kb-rec.mp4 &
rec=$!
sleep 1
node tools/adb.mjs restart
wait $rec || true
"$ADB" pull /sdcard/kb-rec.mp4 "$out/rec.mp4" >/dev/null
rm -f "$out"/f-*.png
"$ffmpeg" -loglevel error -i "$out/rec.mp4" -vf "fps=8,scale=360:-1" "$out/f-%03d.png"
ls "$out" | grep -c '^f-'
