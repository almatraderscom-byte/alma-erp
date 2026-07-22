# iOS Live Voice — TestFlight Handoff (2026-07-22)

## Owner request

Do not upload a TestFlight build until Maruf explicitly confirms. Before that confirmation, combine this branch with the other iOS work being carried in the receiving Claude session, verify the complete app yourself, and only prepare one clean, main-current candidate. The final experience must behave like a Claude/Kimi-style live AI call: continuous model speech, fast real-user interruption, no self-echo loop, and correct tool/agent-turn states.

## Source branch and commits

- Branch: `codex/voice-call-reliability`
- Latest handoff commit: recorded by the commit that adds this note
- Core live-voice commits, oldest to newest:
  - `20287fc5` — voice/call lifecycle reliability baseline
  - `f592bab6` — expose realtime connection state
  - `536f9206` — realtime transport diagnostics
  - `397069ab` — unblock preview/token minting
  - `40132bcd` — complete Gemini realtime handshake
  - `c0e3f900` — persistent AI-call UI and lifecycle
  - `5d2601d6` — continuous playback plus self-echo protection
  - `cf762ad2` — finish acknowledgement audio at `generationComplete`; show `thinking` while the head/tool turn is pending

The backend/web portion of this work is being landed on `main` separately. Re-fetch `origin/main` before integration; do not duplicate or revert those changes.

## Native files intentionally kept on this branch

- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/AssistantTransport.swift`
- `ios/App/App/AssistantVoiceSwiftUI.swift`
- `src/agent/lib/__tests__/native-voice-upload-contract.test.ts`

Do not remove the existing human-to-human/Twilio calling capability. This feature is the live AI voice section, not a replacement for the existing “call a person” agent action.

## Integration procedure for the receiving session

1. Start with `git pull` and `git fetch origin`.
2. Identify the receiving session's other iOS branch/work. Preserve it; inspect both diffs before combining.
3. Create one clean candidate branch from the latest `origin/main`, then integrate both the receiving session's iOS work and the four native files above. Resolve conflicts by behavior, not by blindly choosing one side.
4. Confirm the resulting candidate contains all previously shipped iOS features. Do not archive from a dirty, behind-main, or unpushed checkout.
5. Do not bump the build number, archive, or upload until Maruf explicitly confirms after seeing the verification report.

## Required behavior verification

Use the `iPhone 17 Pro Max` iOS 26.5 simulator first. Verify all of the following in one end-to-end session:

- Live WebSocket setup succeeds and the UI says realtime only after the setup handshake.
- The greeting produces exactly one `listening -> speaking -> listening` cycle. It must not switch state per PCM chunk or per word.
- Keep the call silent for at least 15 seconds after model speech. The model must not hear its own speaker output as a new user turn.
- While the model is speaking, interrupt with a real spoken sentence. It must stop quickly, preserve the beginning of the user's sentence through pre-roll, transcribe it once, and answer it once.
- Exercise a request that invokes `run_agent_turn`. A short acknowledgement may play, then playback must close on Gemini `generationComplete`; the UI must show `thinking` while the head/tool result is pending; the final result must start a new speaking turn and end in listening.
- Mute/unmute, speaker off/on, minimize/resume with preserved timer, chat handoff, image entry, disconnect/retry, and end-call all work.
- No `MIC` transcript may be created from the model's own Bangla voice.
- Existing person-call approval, final delivery status, and Telegram summary flows remain intact; do not conflate them with the AI call UI.

Useful trace markers:

- `ALMA-VOICE playback turn started prebuffer=...`
- `ALMA-VOICE playback turn finished`
- `ALMA-VOICE local barge-in...`
- `ALMA-VOICE server confirmed interruption`
- `ALMA-VOICE state listening -> speaking`
- `ALMA-VOICE state speaking -> listening` or `speaking -> thinking` during a pending tool turn

## Mandatory verification gates before asking for TestFlight confirmation

- `npm run type-check`
- `npm run test:agent`
- `git diff --check`
- iOS simulator build using the repo's documented `xcodebuild` command and `iPhone 17 Pro Max`
- Install and launch the built app in Simulator; capture screenshots and relevant `ALMA-VOICE` logs
- Check any WebView/UI changes in the owner's logged-in Chrome with `?native=1`
- Report the exact candidate branch, commit SHA, changed-file scope, test counts, simulator observations, and remaining hardware-only checks

## TestFlight gate after owner confirmation

Only after Maruf says to proceed:

1. Ensure the candidate is clean, pushed, and contains the latest `origin/main`.
2. Run `bash scripts/ios-build-preflight.sh`; fix any failure instead of bypassing it.
3. Bump `CURRENT_PROJECT_VERSION`, commit the bump, and push it before archiving.
4. Archive/upload exactly that pushed commit and report the build number plus `ALMAGitCommit` SHA.

No TestFlight build was created during this handoff session.
