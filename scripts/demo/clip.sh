#!/usr/bin/env bash
# Turn a raw screen recording into a deck clip: demo/out/<name>.mp4 (H.264, yuv420p, faststart, no audio),
# <name>.webm (VP9) and <name>.jpg (poster frame).
#
#   scripts/demo/clip.sh <input> <name> [options]
#     --in S         trim start, seconds into the raw file (default 0)
#     --out S        trim end, seconds into the raw file (default: end)
#     --fast A-B:X   play raw seconds A..B at X times speed (repeatable; e.g. --fast 4.5-9:4 squeezes typing dots)
#     --crop W:H:X:Y crop the raw frame first (ffmpeg crop syntax, raw pixels)
#     --phone        iPhone screen recording / iPhone Mirroring capture: portrait, scaled to 720 tall
#     --statusbar P  with --phone: cut P pixels (raw) off the top, e.g. 140 for a 1179x2556 recording
#     --poster S     poster time in seconds of the FINISHED clip (default: 0.4s before the end)
#     --crf N        H.264 CRF (default 26 desktop / 24 phone; VP9 uses N+8)
#
# Examples:
#   scripts/demo/clip.sh demo/raw/05-host.webm 05-host --in 1 --out 14 --fast 6-10:3
#   scripts/demo/clip.sh demo/raw/03-onboarding.MP4 03-onboarding --phone --statusbar 140 --fast 8-15:3
set -euo pipefail

FFMPEG=${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}
FFPROBE=${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}
[ $# -ge 2 ] || { sed -n '2,19p' "$0"; exit 1; }
IN=$1 NAME=$2; shift 2
T0=0 T1="" CROP="" PHONE=0 BAR=0 POSTER="" CRF="" FAST=()
while [ $# -gt 0 ]; do
  case $1 in
    --in) T0=$2; shift ;;
    --out) T1=$2; shift ;;
    --fast) FAST+=("$2"); shift ;;
    --crop) CROP=$2; shift ;;
    --phone) PHONE=1 ;;
    --statusbar) BAR=$2; shift ;;
    --poster) POSTER=$2; shift ;;
    --crf) CRF=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$T1" ] || T1=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$IN")
OUTDIR="$(cd "$(dirname "$0")/../.." && pwd)/demo/out"
mkdir -p "$OUTDIR"

# Frame prep: crop, then scale. Desktop: fit 1280x720 (720p-ish). Phone: 720 tall, even width.
PRE="fps=30"
[ -n "$CROP" ] && PRE="$PRE,crop=$CROP"
if [ "$PHONE" = 1 ]; then
  [ "$BAR" != 0 ] && PRE="$PRE,crop=iw:ih-$BAR:0:$BAR"
  PRE="$PRE,scale=-2:720:flags=lanczos"
  CRF=${CRF:-24}
else
  PRE="$PRE,scale='min(1280,iw)':-2:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2"
  CRF=${CRF:-26}
fi

# Timeline: split [T0,T1] into normal and sped-up segments, each re-timed with setpts, then concat.
# Segment list is computed in awk: "start end speed" per line, in order.
SEGS=$(printf '%s\n' "${FAST[@]:-}" | awk -v t0="$T0" -v t1="$T1" '
  NF { split($0, a, "[-:]"); n++; s[n]=a[1]; e[n]=a[2]; x[n]=a[3] }
  END {
    # sort by start
    for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) if (s[j]<s[i]) { t=s[i];s[i]=s[j];s[j]=t; t=e[i];e[i]=e[j];e[j]=t; t=x[i];x[i]=x[j];x[j]=t }
    c=t0
    for (i=1;i<=n;i++) {
      a1 = s[i] < t0 ? t0 : s[i]; b1 = e[i] > t1 ? t1 : e[i]
      if (b1 <= a1 || a1 < c) continue
      if (a1 > c) print c, a1, 1
      print a1, b1, x[i]; c=b1
    }
    if (c < t1) print c, t1, 1
  }')

FILTER="" LABELS="" N=0 DUR=0
while read -r A B X; do
  FILTER+="[0:v]trim=start=$A:end=$B,setpts=(PTS-STARTPTS)/$X[s$N];"
  LABELS+="[s$N]"
  DUR=$(awk -v d="$DUR" -v a="$A" -v b="$B" -v x="$X" 'BEGIN{print d+(b-a)/x}')
  N=$((N+1))
done <<< "$SEGS"
FILTER+="${LABELS}concat=n=$N:v=1:a=0,$PRE,format=yuv420p[v]"

MP4="$OUTDIR/$NAME.mp4"
"$FFMPEG" -v error -y -i "$IN" -filter_complex "$FILTER" -map '[v]' -an \
  -c:v libx264 -preset slow -crf "$CRF" -profile:v high -movflags +faststart "$MP4"
"$FFMPEG" -v error -y -i "$IN" -filter_complex "$FILTER" -map '[v]' -an -c:v libvpx-vp9 -crf $((CRF + 8)) -b:v 0 -row-mt 1 -deadline good "$OUTDIR/$NAME.webm"
[ -n "$POSTER" ] || POSTER=$(awk -v d="$DUR" 'BEGIN{print d-0.4}') # the payoff is usually the last beat
"$FFMPEG" -v error -y -ss "$POSTER" -i "$MP4" -frames:v 1 -q:v 3 "$OUTDIR/$NAME.jpg"

for f in "$MP4" "$OUTDIR/$NAME.webm" "$OUTDIR/$NAME.jpg"; do
  printf '%-48s %6s KB' "${f#"$OUTDIR"/}" $(( $(stat -f%z "$f" 2>/dev/null || stat -c%s "$f") / 1024 ))
  case $f in *.jpg) echo ;; *) printf '  %.1fs\n' "$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$f")" ;; esac
done
