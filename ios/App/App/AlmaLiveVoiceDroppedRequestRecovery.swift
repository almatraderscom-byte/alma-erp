//
//  AlmaLiveVoiceDroppedRequestRecovery.swift
//  App
//
//  Gemini Live (both 2.5 native-audio and 3.1) DISCARDS user content that
//  arrives while the model's own turn is open: the server reports
//  "INTERRUPTED model turn" and the model's next turn starts fresh, as if
//  Boss never spoke (live-reproduced 2026-08-13 — a report request injected
//  during the greeting was swallowed and answered with a new greeting).
//  That is why the owner has to repeat himself. This is the client-side
//  recovery: when an interruption swallows an owner request and the model's
//  next spoken turn settles without doing any work, the harness re-sends the
//  stashed request itself — clearly marked as a harness correction so the
//  model does not mistake it for new speech.
//

import Foundation

struct AlmaLiveVoiceDroppedRequestRecovery {
    /// The owner request most recently at risk of being swallowed by an
    /// interruption. Nil when nothing is pending recovery.
    private(set) var stashedRequest: String?

    /// Loop guard shared with the follow-through sibling: at most 2 resends
    /// per call, spaced 8 s apart — a model that ignores two replays will
    /// ignore ten, and the owner hears the truth instead of an echo loop.
    private var budget: AlmaLiveVoiceWorkFollowThrough.Budget

    init(budget: AlmaLiveVoiceWorkFollowThrough.Budget = .init(limit: 2, minimumSpacing: 8)) {
        self.budget = budget
    }

    /// Keep only meaningful owner speech: non-empty after trimming and at
    /// least 6 characters. Short fillers ("হুম", "হ্যাঁ") never replace a
    /// stashed real request.
    mutating func stash(_ transcript: String) {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 6 else { return }
        stashedRequest = text
    }

    /// Returns and clears the stash if the budget allows a resend now.
    /// A spacing/limit refusal keeps the stash untouched (nothing was sent),
    /// and an empty stash never spends budget.
    mutating func consumeForResend(now: Date = Date()) -> String? {
        guard let request = stashedRequest else { return nil }
        guard budget.claim(now: now) else { return nil }
        stashedRequest = nil
        return request
    }

    mutating func clear() { stashedRequest = nil }

    /// The replay instruction. Framed as a harness correction — the model must
    /// treat it as the OLD request it dropped, not as new speech from Boss.
    static func resendText(_ request: String) -> String {
        "[হারনেস সংশোধনী — এটা Boss-এর নতুন কথা নয়] Boss একটু আগে বলেছিলেন: "
        + "«\(request)» — তোমার টার্নের সাথে ধাক্কা লেগে সেটা হারিয়ে গিয়েছিল। "
        + "এখন ঠিক ওই অনুরোধের জবাব দাও বা প্রযোজ্য tool call করো "
        + "(quick_erp_lookup / run_agent_turn)।"
    }
}
