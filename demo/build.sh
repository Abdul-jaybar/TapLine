#!/usr/bin/env bash
# Cuts the demo video from recorded footage, cards and the voiceover.
# Usage: demo/build.sh <recDir> <out.mp4>
#   <recDir> holds d2/master.mp4 (desktop footage), m2/master.mp4 (phone footage),
#   cards/*.png (from cards.cjs), vo/vo.wav (voiceover) and vo/sfx.wav (from sfx.py).
set -euo pipefail
R="$1"; OUT="$2"; T="$R/tmp"; mkdir -p "$T"
ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -an)

card() { # card <png> <seconds> <out>
  ffmpeg -v error -y -loop 1 -t "$2" -i "$R/cards/$1" -vf "fade=in:st=0:d=0.35,fade=out:st=$(echo "$2-0.3" | bc):d=0.3,format=yuv420p" "${ENC[@]}" "$T/$3"
}
clip() { # clip <start> <seconds> <caption png> <out>
  ffmpeg -v error -y -ss "$1" -t "$2" -i "$R/d2/master.mp4" -loop 1 -t "$2" -i "$R/cards/$3" \
    -filter_complex "[0:v][1:v]overlay=0:0,fade=in:st=0:d=0.25,fade=out:st=$(echo "$2-0.25" | bc):d=0.25,format=yuv420p" "${ENC[@]}" "$T/$4"
}

card card1.png 5.0 s01.mp4          # "Live games move fast. Trading them doesn't."
card card2.png 7.4 s02.mp4          # find a contract, type a price, pick a size
card title.png 2.6 s03.mp4          # "This is TapLine."
clip 1.0   10.5 cap_c.png s04.mp4   # overview and hovering squares
clip 8.2   11.0 cap_d.png s05.mp4   # tapping above and below
clip 184.3 6.0  cap_e.png s06.mp4   # a real hit (lands ~2.7s in)
clip 42.4  6.0  cap_f.png s07.mp4   # a real miss (lands ~2.5s in)
card how.png 7.0 s08.mp4            # one tap = ordinary Gemini orders
# phone: real phone-size footage inside a frame
ffmpeg -v error -y -loop 1 -t 3.5 -i "$R/cards/phonebg.png" -ss 6.4 -t 3.5 -i "$R/m2/master.mp4" -loop 1 -t 3.5 -i "$R/cards/phoneframe.png" \
  -filter_complex "[1:v]scale=305:660[ph];[0:v][ph]overlay=820:30[a];[a][2:v]overlay=0:0,fade=in:st=0:d=0.25,fade=out:st=3.25:d=0.25,format=yuv420p" "${ENC[@]}" "$T/s09.mp4"
card end.png 5.0 s10.mp4

: > "$T/list.txt"; for i in 01 02 03 04 05 06 07 08 09 10; do echo "file 's$i.mp4'" >> "$T/list.txt"; done
ffmpeg -v error -y -f concat -safe 0 -i "$T/list.txt" -c copy "$T/video.mp4"
# Voiceover starts 0.6s in; app sound cues (recreated at the real event times) sit quietly under it.
ffmpeg -v error -y -i "$T/video.mp4" -i "$R/vo/vo.wav" -i "$R/vo/sfx.wav" \
  -filter_complex "[1:a]adelay=600:all=1,volume=1.6[vo];[2:a]volume=0.5[fx];[vo][fx]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart "$OUT"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT"
