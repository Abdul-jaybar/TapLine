"""Recreates the app's sound cues (tap blips, win chime, miss thud) at the times the real events
happen in the cut, since screen capture has no audio. Usage: python3 sfx.py <recDir> <out.wav>"""
import json, math, struct, sys, wave

rec, out = sys.argv[1], sys.argv[2]
SR, TOTAL = 44100, 64.0
buf = [0.0] * int(SR * TOTAL)

def tone(t0, f0, f1, dur, gain, shape="tri"):
    n = int(SR * dur); start = int(SR * t0); phase = 0.0
    for i in range(n):
        if start + i >= len(buf): break
        k = i / n
        f = f0 * (f1 / f0) ** k if f1 else f0
        phase += 2 * math.pi * f / SR
        s = math.sin(phase) if shape == "sine" else (2 / math.pi) * math.asin(math.sin(phase))
        env = min(1, i / (0.008 * SR)) * (1 - k) ** 2
        buf[start + i] += s * env * gain

log = json.load(open(f"{rec}/d2/log.json"))
# (segment start in the cut, source start, length) for the desktop clips; must match build.sh
CLIPS = [(15.0, 1.0, 10.5), (25.5, 8.2, 11.0), (36.5, 184.3, 6.0), (42.5, 42.4, 6.0)]
for cut_t, src_t, length in CLIPS:
    seen_win = seen_miss = False
    for e in log:
        dt = e["t"] - src_t
        if not (0.1 <= dt <= length - 0.1): continue
        t = cut_t + dt
        if e["what"] == "tap":
            tone(t, 560, 950, 0.08, 0.35)
        elif e.get("status") == "won" and not seen_win:
            seen_win = True
            for i, f in enumerate([523.25, 659.25, 783.99, 1046.5]): tone(t + 0.16 + i * 0.06, f, 0, 0.24, 0.3)
            tone(t + 0.42, 2093, 0, 0.5, 0.12, "sine")
        elif e.get("status") == "expired" and not seen_miss:
            seen_miss = True
            tone(t + 0.16, 160, 70, 0.26, 0.5, "sine")

with wave.open(out, "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 30000)) for s in buf))
print("sfx written")
