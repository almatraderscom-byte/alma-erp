# Phase E1 Report — Audio Lab (ElevenLabs)

**Date:** 2026-07-05 · **Branch:** `agent-phase-e1` · **Tag:** `pre-agent-phase-e1`

## Shipped

New **অডিও ল্যাব** tab in the Studio — everything ElevenLabs, hard presets only:

1. **ভয়েস ক্লোন (one-time):** owner uploads 1–3 consented samples (signed
   direct upload) → worker calls /voices/add → id saved in kv
   `studio_owner_voice_id`. **GUARDRAIL:** the cloned voice is readable ONLY by
   owner-initiated `owner_voice` jobs — never autonomous/customer flows.
2. **Text → মিউজিক:** 3 hard style presets (উৎসব / শান্ত / **নাশিদ vocals-only**
   — the Islamic-guardrail option), owner mood line optional, 30/60s.
3. **উইশ গান:** জন্মদিন/বিবাহবার্ষিকী/ঈদ — FIXED Bangla lyric sheets, owner
   supplies only the name (never LLM-written lyrics).
4. **আমার ভয়েসে বলাও:** owner-typed line → cloned-voice TTS.
5. **ভয়েস নোট → স্টুডিও কোয়ালিটি:** upload → ElevenLabs Audio Isolation.
6. **SFX generator:** short effects for reels (feeds V3 templates).

Mechanics: `audio_gen` pending-actions → `audio-gen` BullMQ queue →
`worker/src/audio-lab.mjs`; outputs `generated/<id>.mp3` in the Gallery
(🎵 tiles + lightbox player) and the Drive archive sweep; per-run cost logged
(`cost-log`, provider elevenlabs) and the ৳ estimate shown in every toast
before the money is spent. Pure builders in `audio-lab.ts` (5 unit tests).

## Verification
| Check | Result |
|---|---|
| Builder tests 5/5 · lib suite · tsc · next build · node --check worker | PASS |
| Live e2e (music/clone) | spends ElevenLabs credits — first runs together with the owner from the UI |
