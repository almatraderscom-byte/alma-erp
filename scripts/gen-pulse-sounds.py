#!/usr/bin/env python3
"""
Generate the ALMA Dynamic Panel notification sounds.

Run:  python3 scripts/gen-pulse-sounds.py
Out:  ios/App/App/Sounds/{alma_approval,alma_urgent,alma_reminder}.caf

These are synthesised from scratch (sine partials + an exponential decay
envelope) so they are ALMA's own sounds — never a copy of an Apple system sound
(spec §11.2). They are committed to git, but this script is the source of truth:
regenerate rather than hand-editing the binaries.

Design (spec §11.2):
  • alma_approval  — soft glass-like two-note UPWARD chime (A5 → D6)
  • alma_urgent    — clear but short DOUBLE note, no harsh alarm character
  • alma_reminder  — quieter single note derived from the approval sound

All are short, clean and deliberately low in perceived loudness. iOS requires a
notification sound under 30s; these are all well under 1s.
"""
import math
import os
import struct
import subprocess
import wave

SAMPLE_RATE = 44100
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "ios", "App", "App", "Sounds")

# Equal-temperament pitches used below.
A5 = 880.00
D6 = 1174.66
C6 = 1046.50


def tone(freq, dur, amp, attack=0.008, decay=6.0):
    """One note: fundamental + a quiet 2nd partial (the 'glass'), with a soft
    attack and an exponential decay so nothing clicks or rings harshly."""
    out = []
    n = int(SAMPLE_RATE * dur)
    for i in range(n):
        t = i / SAMPLE_RATE
        env = math.exp(-decay * t)
        # Linear fade-in avoids the click a hard start would make.
        if t < attack:
            env *= t / attack
        s = math.sin(2 * math.pi * freq * t)
        s += 0.28 * math.sin(2 * math.pi * freq * 2 * t)  # 2nd partial
        out.append(amp * env * s / 1.28)
    return out


def silence(dur):
    return [0.0] * int(SAMPLE_RATE * dur)


def mix_sequential(*segments):
    buf = []
    for seg in segments:
        buf.extend(seg)
    return buf


def write_wav(path, samples):
    """16-bit mono PCM, soft-limited so no sample ever clips."""
    peak = max((abs(s) for s in samples), default=0.0)
    scale = 1.0 if peak <= 1.0 else 1.0 / peak
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        frames = b"".join(
            struct.pack("<h", int(max(-1.0, min(1.0, s * scale)) * 32767)) for s in samples
        )
        w.writeframes(frames)


def to_caf(wav_path, caf_path):
    subprocess.run(
        ["afconvert", "-f", "caff", "-d", "LEI16@44100", "-c", "1", wav_path, caf_path],
        check=True,
    )
    os.remove(wav_path)


def build():
    os.makedirs(OUT_DIR, exist_ok=True)

    sounds = {
        # Two notes rising — "something is ready for you".
        "alma_approval": mix_sequential(
            tone(A5, 0.22, 0.55),
            tone(D6, 0.40, 0.50, decay=5.0),
        ),
        # Two clear equal notes — attention, but not an alarm.
        "alma_urgent": mix_sequential(
            tone(C6, 0.16, 0.62, decay=9.0),
            silence(0.05),
            tone(C6, 0.28, 0.62, decay=7.0),
        ),
        # The approval's first note alone, quieter — a nudge, not a demand.
        "alma_reminder": tone(A5, 0.34, 0.34, decay=6.5),
    }

    for name, samples in sounds.items():
        wav = os.path.join(OUT_DIR, name + ".wav")
        caf = os.path.join(OUT_DIR, name + ".caf")
        write_wav(wav, samples)
        to_caf(wav, caf)
        print("wrote", os.path.relpath(caf))


if __name__ == "__main__":
    build()
