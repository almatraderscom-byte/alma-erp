//
//  NativeSpeechBridge.swift
//  App
//
//  Local Capacitor plugin exposing Apple's ON-DEVICE speech recognition to the web
//  app, so dictation can be transcribed for free, offline, with no Whisper API
//  round-trip. The web side (src/lib/native-speech.ts) feature-detects the plugin,
//  gates on the native build number AND an owner opt-in flag (`alma_native_stt`),
//  and falls back to the existing Whisper server path whenever on-device STT is
//  unavailable or returns nothing.
//
//  JS side calls:
//    NativeSpeechBridge.availability({ locale })              → { available, ... }
//    NativeSpeechBridge.transcribe({ audioBase64, locale })   → { text, onDevice }
//
//  Engine: SFSpeechRecognizer with `requiresOnDeviceRecognition = true` (iOS 16+,
//  no network, no cost). The recorder in useVoiceRecorder produces a full audio
//  blob and then transcribes it, so file-based (one-shot) recognition is the exact
//  drop-in. iOS 26 `SpeechAnalyzer`/`SpeechTranscriber` is a documented future
//  quality upgrade (see agent-ios-native-handoff.md Phase N2) — deliberately NOT
//  wired blind here so the device build stays green; it layers on after the owner
//  verifies Bangla accuracy on device.
//
//  Registered by AlmaBridgeViewController.capacitorDidLoad() via
//  registerPluginInstance(), exactly like LiveActivityBridge / NativeIntelligence.
//
//  Safety contract: this plugin NEVER crashes and NEVER rejects-hard. Below iOS 16,
//  when Speech is unavailable at compile time, when unauthorized, or on any thrown
//  error, every method resolves a falsy result so the web layer uses Whisper.
//

import Capacitor
import Foundation

#if canImport(Speech)
import Speech
#endif

@objc(NativeSpeechBridgePlugin)
public class NativeSpeechBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSpeechBridgePlugin"
    public let jsName = "NativeSpeechBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribe", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - availability

    /// Reports whether ON-DEVICE recognition can be used right now for `locale`.
    @objc public func availability(_ call: CAPPluginCall) {
        let locale = call.getString("locale", "bn-BD")

        #if canImport(Speech)
        if #available(iOS 16, *) {
            let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
            let onDeviceSupported = recognizer?.supportsOnDeviceRecognition ?? false
            let isAvailable = recognizer?.isAvailable ?? false
            call.resolve([
                "available": isAvailable && onDeviceSupported,
                "onDeviceSupported": onDeviceSupported,
                "authStatus": authString(SFSpeechRecognizer.authorizationStatus())
            ])
            return
        }
        #endif
        call.resolve(["available": false, "reason": "unsupported_os"])
    }

    // MARK: - transcribe

    /// Transcribe a base64-encoded audio clip on-device. Resolves
    /// `{ text, onDevice:true }` on success, or `{ text:"", onDevice:false }` on any
    /// failure / unavailability so the caller falls back to Whisper.
    @objc public func transcribe(_ call: CAPPluginCall) {
        let audioBase64 = stripDataURL(call.getString("audioBase64", ""))
        let locale = call.getString("locale", "bn-BD")

        guard !audioBase64.isEmpty, let data = Data(base64Encoded: audioBase64), !data.isEmpty else {
            call.resolve(["text": "", "onDevice": false, "reason": "bad_input"])
            return
        }

        #if canImport(Speech)
        if #available(iOS 16, *) {
            requestAuthorization { [weak self] granted in
                guard let self = self else {
                    call.resolve(["text": "", "onDevice": false, "reason": "released"])
                    return
                }
                guard granted else {
                    call.resolve(["text": "", "onDevice": false, "reason": "not_authorized"])
                    return
                }
                guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
                      recognizer.isAvailable else {
                    call.resolve(["text": "", "onDevice": false, "reason": "recognizer_unavailable"])
                    return
                }

                // Persist the clip to a temp file — SFSpeechURLRecognitionRequest reads a URL.
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("alma-stt-\(UUID().uuidString).m4a")
                do {
                    try data.write(to: url)
                } catch {
                    call.resolve(["text": "", "onDevice": false, "reason": "write_failed"])
                    return
                }

                let request = SFSpeechURLRecognitionRequest(url: url)
                request.shouldReportPartialResults = false
                let onDevice = recognizer.supportsOnDeviceRecognition
                if onDevice { request.requiresOnDeviceRecognition = true }

                var settled = false
                let finish: (String, Bool, String?) -> Void = { text, isOnDevice, reason in
                    if settled { return }
                    settled = true
                    try? FileManager.default.removeItem(at: url)
                    var payload: [String: Any] = ["text": text, "onDevice": isOnDevice]
                    if let reason = reason { payload["reason"] = reason }
                    call.resolve(payload)
                }

                recognizer.recognitionTask(with: request) { result, error in
                    if let error = error {
                        finish("", false, "recognition_failed:\(error.localizedDescription)")
                        return
                    }
                    guard let result = result else { return }
                    if result.isFinal {
                        let text = result.bestTranscription.formattedString
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if text.isEmpty {
                            finish("", false, "empty_output")
                        } else {
                            finish(text, onDevice, nil)
                        }
                    }
                }
            }
            return
        }
        #endif

        call.resolve(["text": "", "onDevice": false, "reason": "unsupported_os"])
    }

    // MARK: - Helpers

    /// Strip a `data:audio/...;base64,` prefix if the web side sent a data URL.
    private func stripDataURL(_ s: String) -> String {
        if let range = s.range(of: ";base64,") {
            return String(s[range.upperBound...])
        }
        return s
    }

    #if canImport(Speech)
    @available(iOS 16, *)
    private func authString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    /// Ensure Speech authorization, prompting once if not yet determined. Requires
    /// NSSpeechRecognitionUsageDescription in Info.plist (added in this same phase).
    @available(iOS 16, *)
    private func requestAuthorization(_ completion: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            completion(true)
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                completion(status == .authorized)
            }
        default:
            completion(false)
        }
    }
    #endif
}
