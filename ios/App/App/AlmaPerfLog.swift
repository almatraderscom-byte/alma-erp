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

#if DEBUG
/// Deterministic companion to Simulator signposts for the headless Robot preview.
///
/// `simctl log stream` can omit signpost point events even when the app completed
/// the interaction sequence. This tiny cache file is read only by CI from the
/// Simulator app container; it is never compiled into TestFlight/Release builds.
enum RobotSelfTestTrace {
    static let fileName = "alma-robot-selftest.txt"

    private static let lock = NSLock()

    private static var fileURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(fileName, isDirectory: false)
    }

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        guard let fileURL else { return }
        try? "robotSelfTest.start\n".write(
            to: fileURL,
            atomically: true,
            encoding: .utf8
        )
    }

    static func mark(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let fileURL,
              let data = "\(event)\n".data(using: .utf8) else { return }

        if !FileManager.default.fileExists(atPath: fileURL.path) {
            _ = FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return }
        defer { try? handle.close() }
        try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}
#endif
