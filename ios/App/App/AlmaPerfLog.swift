//
//  AlmaPerfLog.swift
//  ALMA ERP — IOSP-0 performance-baseline signposts.
//
//  Point events on one subsystem so launch → content, route → content, and
//  API request volume/duration are measurable from `log stream`/Instruments
//  without any behaviour change. Timing = deltas between events on the log
//  timeline. Carries route paths and status codes only — never payloads,
//  cookies, or user content. The agent turn lifecycle keeps its own
//  AlmaTurnLog (com.almatraders.erp.agent) — turn.submit → stream.bufferFlush
//  already brackets send → first token; this log does not duplicate it.
//
//  Baseline capture (IOSP-0):
//    xcrun simctl spawn <udid> log stream --style compact \
//      --predicate 'subsystem == "com.almatraders.erp.perf"'
//

import Foundation
import os.signpost

enum AlmaPerfLog {
    static let log = OSLog(subsystem: "com.almatraders.erp.perf", category: "Perf")

    /// Emit a single signpost point event. `info` must stay metadata-sized
    /// (route path, status, milliseconds) — never request/response bodies.
    static func event(_ name: StaticString, _ info: String = "") {
        os_signpost(.event, log: log, name: name, "%{public}s", info)
    }
}
