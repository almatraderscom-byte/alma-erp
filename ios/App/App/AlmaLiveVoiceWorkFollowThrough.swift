//
//  AlmaLiveVoiceWorkFollowThrough.swift
//  App
//
//  A spoken promise is not work. The head already enforces this with its
//  claim-verifier/self-correct loop; the live call had no equivalent, so the
//  model could say "দেখছি, একটু সময় লাগবে" — on BOTH Gemini live models — and
//  drop back to listening without ever calling a tool (owner reports
//  2026-08-12/13). This is the client-side contract that refuses to accept
//  that: a work-promising turn that made no tool call gets one immediate
//  corrective instruction instead of a quiet return to listening.
//

import Foundation

enum AlmaLiveVoiceWorkFollowThrough {
    /// Conservative Bangla work-promise markers. Every entry is something ALMA
    /// says when she claims to be DOING something; plain conversation and
    /// questions do not match.
    private static let promiseMarkers: [String] = [
        "দেখছি", "দেখে জানাচ্ছি", "চেক করছি", "করে দিচ্ছি", "আনছি",
        "খুঁজছি", "চেষ্টা করছি", "ব্যবস্থা করছি", "বের করছি",
        "একটু সময়", "অপেক্ষা করুন", "সময় দিন", "নিয়ে আসছি",
    ]

    /// Did this spoken turn promise work?
    static func promisesWork(_ spokenTurn: String) -> Bool {
        let text = spokenTurn.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        return promiseMarkers.contains { text.contains($0) }
    }

    /// The corrective instruction. Framed as a harness correction, not Boss —
    /// the model must either call the tool NOW or state plainly that it cannot.
    static let correction =
        "[হারনেস সংশোধনী — এটা Boss-এর কথা নয়] তুমি এইমাত্র কাজ করার কথা বলেছ "
        + "কিন্তু কোনো tool call করোনি। মুখে বলা কাজ নয়। এখনই সিদ্ধান্ত নাও: "
        + "সাধারণ তথ্য হলে quick_erp_lookup, কাজ/রিপোর্ট/বিশ্লেষণ হলে run_agent_turn — "
        + "ঠিক এই মুহূর্তে call করো। call করা সম্ভব না হলে Boss-কে এক বাক্যে স্পষ্ট বলো "
        + "কাজটা এখন করা যাচ্ছে না এবং কারণ কী।"

    /// Loop guard: corrections per call are bounded and spaced. A model that
    /// ignores two corrections will ignore ten — after the budget the truth
    /// goes to the owner instead of another nudge.
    struct Budget {
        private(set) var used = 0
        private(set) var lastAt: Date?
        let limit: Int
        let minimumSpacing: TimeInterval

        init(limit: Int = 3, minimumSpacing: TimeInterval = 8) {
            self.limit = limit
            self.minimumSpacing = minimumSpacing
        }

        mutating func claim(now: Date = Date()) -> Bool {
            guard used < limit else { return false }
            if let lastAt, now.timeIntervalSince(lastAt) < minimumSpacing { return false }
            used += 1
            lastAt = now
            return true
        }
    }
}
