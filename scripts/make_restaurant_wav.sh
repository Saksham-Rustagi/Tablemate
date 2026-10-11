#!/usr/bin/env bash
# Builds data/restaurant_full_then_745.wav: the "restaurant host" side of a demo web call, for Chrome's
#   --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=data/restaurant_full_then_745.wav
# Silences give the Tablemate agent time to talk between lines.
set -euo pipefail
cd "$(dirname "$0")/.."

VOICE="${VOICE:-Daniel}"
if ! say -v '?' | grep -q "^${VOICE} "; then
  VOICE="$(say -v '?' | grep -E ' en_(US|GB) ' | head -1 | awk '{print $1}')"
fi

OUT=data/restaurant_full_then_745.wav
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p data

say -v "$VOICE" -o "$TMP/host.aiff" \
  "[[slnc 2000]] Hi, thanks for calling Momo's Master, this is Jamie. \
[[slnc 9000]] Ah, we're fully booked at seven thirty, but I could do seven forty-five. \
[[slnc 9000]] Perfect. What name should I put it under? \
[[slnc 7000]] Great, you're all set, table at seven forty-five. See you tonight! \
[[slnc 8000]]"

afconvert -f WAVE -d LEI16@48000 "$TMP/host.aiff" "$OUT"

echo "voice: $VOICE"
echo "wrote: $OUT"
afinfo "$OUT" | grep -E "estimated duration|Data format|File type"
