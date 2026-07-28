//
//  OfficeRobotLiveGlyph.swift
//  AlmaWidget extension target only.
//
//  A deliberately small Dynamic Island renderer for the Office Robot.
//  It uses pre-cropped widget-owned frames instead of loading the app's
//  1536×2288 atlas (about 14 MB decoded) inside the extension.
//
//  TimelineView requests occasional local redraws without spending ActivityKit
//  update budget. iOS remains free to coalesce those redraws for power. The
//  reliable contract is state-specific poses; ambient motion is best-effort.
//

import Foundation
import SwiftUI

@available(iOS 16.1, *)
enum OfficeRobotLiveContext {
    case pulse(mode: PulseMode, successAtEpoch: Double?)
    case voice(phase: String)
}

@available(iOS 16.1, *)
struct OfficeRobotLiveGlyph: View {
    private static let frameCount = 20

    let context: OfficeRobotLiveContext
    let size: CGFloat
    var animated = true
    var cadenceMultiplier: Double = 1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if motionAllowed {
                if let dates = successTimelineDates {
                    if dates.isEmpty {
                        frame(index: staticFrameIndex)
                    } else {
                        TimelineView(.explicit(dates)) { timeline in
                            frame(index: frameIndex(at: timeline.date))
                        }
                    }
                } else {
                    TimelineView(.periodic(from: .now, by: refreshInterval)) { timeline in
                        frame(index: frameIndex(at: timeline.date))
                    }
                }
            } else {
                frame(index: staticFrameIndex)
            }
        }
        .frame(width: size, height: size * 13 / 12)
    }

    private var motionAllowed: Bool {
        animated
            && !reduceMotion
            && !ProcessInfo.processInfo.isLowPowerModeEnabled
            && !isOffline
    }

    private var isOffline: Bool {
        if case .pulse(let mode, _) = context { return mode == .offline }
        return false
    }

    /// Success is the only sub-second Pulse animation. An explicit schedule
    /// ends after 3.9 seconds, so a success state that remains live for minutes
    /// settles without continuing to request redraws.
    private var successTimelineDates: [Date]? {
        guard case .pulse(let mode, let successAtEpoch) = context,
              mode == .success else { return nil }
        guard let successAtEpoch else { return [] }

        let start = Date(timeIntervalSince1970: successAtEpoch)
        let now = Date()
        let dates = (0...6).map {
            start.addingTimeInterval(Double($0) * 0.65)
        }
        return dates.filter { $0 >= now.addingTimeInterval(-0.05) }
    }

    /// Voice already has a 0.4s ribbon schedule. Pulse remains deliberately
    /// low-frequency, but its poses change often enough that the compact Robot
    /// visibly looks around during a normal 10–20 second glance.
    private var refreshInterval: TimeInterval {
        switch context {
        case .voice:
            return 0.7 * cadenceMultiplier
        case .pulse(let mode, _):
            switch mode {
            case .success: return 0.65 * cadenceMultiplier
            case .urgent: return 1.15 * cadenceMultiplier
            case .orders, .working: return 1.35 * cadenceMultiplier
            case .approval: return 1.25 * cadenceMultiplier
            default: return 1.50 * cadenceMultiplier
            }
        }
    }

    /// Dynamic Island's compact renderer replaces oversized, runtime-cropped
    /// images with a grey placeholder on some OS/Simulator versions. Each
    /// frame therefore lives as its own tiny 96×104 widget asset.
    private func frame(index: Int) -> some View {
        Image(frameAssetName(index))
            .resizable()
            .renderingMode(.original)
            .interpolation(.none)
            .scaledToFit()
            .accessibilityHidden(true)
    }

    private var staticFrameIndex: Int {
        switch context {
        case .pulse(let mode, _):
            switch mode {
            case .urgent: return 10
            case .approval: return 16
            case .orders: return 9
            case .working: return 6
            case .stale: return 8
            case .offline: return 11
            case .success: return 13
            case .overview: return 0
            }
        case .voice(let phase):
            switch phase {
            case "listening": return 16
            case "thinking": return 3
            case "speaking": return 18
            default: return 0
            }
        }
    }

    private func frameIndex(at date: Date) -> Int {
        switch context {
        case .pulse(let mode, let successAtEpoch):
            return pulseFrame(mode: mode, successAtEpoch: successAtEpoch, date: date)
        case .voice(let phase):
            return voiceFrame(phase: phase, date: date)
        }
    }

    private func pulseFrame(
        mode: PulseMode,
        successAtEpoch: Double?,
        date: Date
    ) -> Int {
        switch mode {
        case .overview:
            return sequence(
                [0, 1, 0, 2, 3, 2, 0, 4, 5, 4, 0],
                date: date
            )
        case .working, .orders:
            return sequence([6, 7, 8, 9, 8, 7, 6, 1], date: date)
        case .approval:
            return sequence([0, 16, 1, 0, 4, 5, 4, 0], date: date)
        case .urgent:
            return sequence([0, 10, 1, 11], date: date)
        case .stale:
            return sequence([8, 8, 1, 8], date: date)
        case .offline:
            return 11
        case .success:
            if let successAtEpoch {
                let age = date.timeIntervalSince1970 - successAtEpoch
                if age >= 0, age < 3.9 {
                    let celebration = [12, 13, 14, 15, 14, 13]
                    let index = min(
                        celebration.count - 1,
                        max(0, Int(age / refreshInterval))
                    )
                    return celebration[index]
                }
            }
            return 13
        }
    }

    private func voiceFrame(phase: String, date: Date) -> Int {
        switch phase {
        case "listening":
            return sequence([16, 0, 16, 1], date: date)
        case "thinking":
            return sequence([2, 3, 2, 0, 4, 5, 4, 0], date: date)
        case "speaking":
            return sequence([17, 18, 19, 18], date: date)
        default:
            return sequence([0, 0, 0, 1, 0, 2, 3, 2, 0, 4, 5, 4], date: date)
        }
    }

    private func sequence(_ indices: [Int], date: Date) -> Int {
        guard !indices.isEmpty else { return staticFrameIndex }
        let tick = Int(floor(date.timeIntervalSince1970 / refreshInterval))
        return indices[abs(tick) % indices.count]
    }

    private func clamped(_ index: Int) -> Int {
        min(Self.frameCount - 1, max(0, index))
    }

    private func frameAssetName(_ index: Int) -> String {
        String(
            format: "AlmaWidgetRobotFrame%02d",
            clamped(index)
        )
    }
}
