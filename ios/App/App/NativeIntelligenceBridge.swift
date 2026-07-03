//
//  NativeIntelligenceBridge.swift
//  App
//
//  Local Capacitor plugin exposing Apple's on-device Foundation Models to the
//  web app, so summarize/classify can run for free, offline, with no server LLM
//  round-trip. The web side (src/lib/native-intelligence.ts) feature-detects the
//  plugin, gates on the native build number, and falls back to the existing
//  server-LLM path whenever the model is unavailable.
//
//  JS side calls:
//    NativeIntelligenceBridge.availability()                 → { available, reason }
//    NativeIntelligenceBridge.summarize({ text, maxWords })  → { summary, onDevice }
//    NativeIntelligenceBridge.classify({ text, labels })     → { label, onDevice }
//
//  This is a *local* plugin (not a published pod). It is registered by
//  AlmaBridgeViewController.capacitorDidLoad() via registerPluginInstance(),
//  exactly like LiveActivityBridge. The CAPBridgedPlugin shape mirrors
//  Capacitor 7's shipped plugins.
//
//  Safety contract (same as LiveActivityBridge): this plugin NEVER crashes and
//  NEVER rejects-hard. FoundationModels is iOS 26+; below that, on unsupported
//  hardware, or when the system model isn't ready, every method resolves with a
//  falsy/empty result so the web layer transparently uses its server fallback.
//

import Capacitor
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

@objc(NativeIntelligenceBridgePlugin)
public class NativeIntelligenceBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeIntelligenceBridgePlugin"
    public let jsName = "NativeIntelligenceBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "summarize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "classify", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - availability

    /// Reports whether the on-device model can be used right now. Reasons mirror
    /// FoundationModels' `SystemLanguageModel.Availability`, plus `unsupported_os`
    /// below iOS 26 and `no_framework` when the SDK lacks FoundationModels.
    @objc public func availability(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                call.resolve(["available": true, "reason": "available"])
            case .unavailable(let reason):
                call.resolve(["available": false, "reason": reasonString(reason)])
            }
            return
        }
        #endif
        call.resolve(["available": false, "reason": "unsupported_os"])
    }

    // MARK: - summarize

    /// Summarize `text` down to roughly `maxWords` words. Resolves
    /// `{ summary, onDevice:true }` on success, or `{ summary:"", onDevice:false }`
    /// on any failure / unavailability so the caller falls back to the server.
    @objc public func summarize(_ call: CAPPluginCall) {
        let text = call.getString("text", "")
        let maxWords = call.getInt("maxWords", 40)

        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.resolve(["summary": "", "onDevice": false, "reason": "empty_input"])
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26, *), case .available = SystemLanguageModel.default.availability {
            let prompt = """
            Summarize the text below in \(maxWords) words or fewer. Keep the same \
            language as the input. Reply with only the summary, no preamble.

            \(text)
            """
            Task {
                do {
                    let session = LanguageModelSession()
                    let response = try await session.respond(to: prompt)
                    let summary = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    if summary.isEmpty {
                        call.resolve(["summary": "", "onDevice": false, "reason": "empty_output"])
                    } else {
                        call.resolve(["summary": summary, "onDevice": true])
                    }
                } catch {
                    call.resolve(["summary": "", "onDevice": false, "reason": "generation_failed",
                                  "error": error.localizedDescription])
                }
            }
            return
        }
        #endif

        call.resolve(["summary": "", "onDevice": false, "reason": "unavailable"])
    }

    // MARK: - classify

    /// Pick the best-fitting label from `labels` for `text`. Resolves
    /// `{ label, onDevice:true }` on success, or `{ label:"", onDevice:false }` on
    /// any failure / unavailability. The chosen label is always one of `labels`
    /// (case-insensitive match); if the model wanders, we resolve onDevice:false so
    /// the caller falls back rather than trusting an off-list answer.
    @objc public func classify(_ call: CAPPluginCall) {
        let text = call.getString("text", "")
        let labels = (call.getArray("labels", []) ?? []).compactMap { $0 as? String }

        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !labels.isEmpty else {
            call.resolve(["label": "", "onDevice": false, "reason": "bad_input"])
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26, *), case .available = SystemLanguageModel.default.availability {
            let labelList = labels.joined(separator: ", ")
            let prompt = """
            Classify the text below into exactly one of these labels: \(labelList).
            Reply with only the single chosen label, exactly as written above.

            \(text)
            """
            Task {
                do {
                    let session = LanguageModelSession()
                    let classification = try await session.respond(
                        to: prompt,
                        generating: Classification.self
                    )
                    let picked = classification.content.label.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let match = labels.first(where: { $0.caseInsensitiveCompare(picked) == .orderedSame }) {
                        call.resolve(["label": match, "onDevice": true])
                    } else {
                        // Off-list answer — don't trust it; let the caller fall back.
                        call.resolve(["label": "", "onDevice": false, "reason": "off_list"])
                    }
                } catch {
                    call.resolve(["label": "", "onDevice": false, "reason": "generation_failed",
                                  "error": error.localizedDescription])
                }
            }
            return
        }
        #endif

        call.resolve(["label": "", "onDevice": false, "reason": "unavailable"])
    }

    // MARK: - Helpers

    #if canImport(FoundationModels)
    /// Map FoundationModels' unavailability reason to a stable string for JS.
    @available(iOS 26, *)
    private func reasonString(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
        switch reason {
        case .deviceNotEligible:
            return "device_not_eligible"
        case .appleIntelligenceNotEnabled:
            return "apple_intelligence_not_enabled"
        case .modelNotReady:
            return "model_not_ready"
        @unknown default:
            return "unavailable"
        }
    }

    /// Guided-generation schema for `classify` — a single free-form label the model
    /// is instructed to choose from the caller's list (we still post-validate it
    /// against `labels` above, so the guarantee is enforced on our side too).
    @available(iOS 26, *)
    @Generable
    private struct Classification {
        @Guide(description: "The single chosen label, copied exactly from the provided list.")
        var label: String
    }
    #endif
}
