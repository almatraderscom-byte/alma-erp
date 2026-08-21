//
//  AlmaAPI.swift
//  App
//
//  Native networking layer for the SwiftUI screens. The WKWebViews (Capacitor tab +
//  the plain content tabs) all share WKWebsiteDataStore.default(), which is where the
//  logged-in Supabase session cookies for alma-erp-six.vercel.app live. Native screens
//  can't read those directly through URLSession, so this class bridges them:
//
//    WKHTTPCookieStore (web login) ──copy──▶ HTTPCookieStorage.shared ──▶ URLSession
//
//  The copy is cheap but WKHTTPCookieStore is main-thread-only and async, so we sync
//  lazily (at most every 30s) instead of before every request. If the ERP answers
//  401/403 — or Next.js 307-redirects to /login, which is its real "not logged in"
//  signal — we force one re-sync and retry once before surfacing notAuthenticated.
//  Redirect following is disabled on the session so that auth redirect stays visible
//  instead of being silently followed to the login HTML page.
//

import Foundation
import UIKit
import WebKit

#if DEBUG
/// Deterministic, simulator-only fault injector used by merge-readiness journeys.
/// It is completely inert unless ALMA_MERGE_MOCK is supplied at process launch;
/// production and ordinary debug sessions retain the real network stack.
final class AlmaMergeReadinessURLProtocol: URLProtocol {
    private static let multiLock = NSLock()
    private static var multiResolvedActionIds: Set<String> = []
    private static var multiRequestCounts: [String: Int] = [:]
    private static var recoveryStreamServed = false
    private static var unexpectedEOFReplayServed = false
    private static var richImageRetryCreated = false
    private static let interactiveLock = NSLock()
    private static var interactiveSelectedModelId = "auto"
    private static var interactiveTurnCounter = 0

    /// DEBUG-only snapshot of the real head-pickable registry. The interactive
    /// Simulator preview must exercise the production model picker without asking
    /// the owner to connect this build to production. Enabled/disabled state remains
    /// deliberately local; only a real authenticated server can know its live map.
    struct InteractivePreviewModel: Equatable {
        let id: String
        let label: String
        let provider: String
        var isDefault = false
        var contextWindow = 200_000
        /// Mirrors the server registry's per-model thinking levels (effort.ts), so
        /// the offline preview harness exercises the SAME picker the app gets live.
        var effortLevels: [String] = []
        var effortDefault: String? = nil

        var json: [String: Any] {
            var out: [String: Any] = ["id": id, "label": label, "provider": provider,
                                      "enabled": true, "default": isDefault,
                                      "contextWindow": contextWindow,
                                      "effortLevels": effortLevels]
            if let effortDefault { out["effortDefault"] = effortDefault }
            return out
        }
    }

    struct InteractivePreviewFrame {
        let delayMilliseconds: Int
        let event: [String: Any]
        var type: String { event["type"] as? String ?? "" }
    }

    static let interactivePreviewModels: [InteractivePreviewModel] = [
        .init(id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", isDefault: true, effortLevels: ["low", "medium", "high", "max"], effortDefault: "high"),
        .init(id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic", effortLevels: ["low", "medium", "high", "xhigh", "max"], effortDefault: "high"),
        .init(id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", effortLevels: ["low", "medium", "high", "max"]),
        .init(id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", provider: "google", effortLevels: ["low", "medium", "high"], effortDefault: "high"),
        .init(id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "google", effortLevels: ["low", "medium", "high"], effortDefault: "medium"),
        .init(id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "google", effortLevels: ["low", "medium", "high"], effortDefault: "low"),
        .init(id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google", effortLevels: ["low", "medium", "high"], effortDefault: "medium"),
        .init(id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai", effortLevels: ["low", "medium", "high", "xhigh", "max"], effortDefault: "medium"),
        .init(id: "gpt-5.5", label: "GPT-5.5", provider: "openai", effortLevels: ["low", "medium", "high", "xhigh"], effortDefault: "medium"),
        .init(id: "gpt-5.4", label: "GPT-5.4", provider: "openai"),
        .init(id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai"),
        .init(id: "or-qwen3-max", label: "Qwen 3.7 Max (OpenRouter)", provider: "openrouter", effortLevels: ["low", "medium", "high"]),
        .init(id: "or-deepseek-v4-flash", label: "DeepSeek V4 Flash (OpenRouter)", provider: "openrouter", effortLevels: ["low", "medium", "high"]),
        .init(id: "or-grok-4.20", label: "Grok 4.20 (OpenRouter)", provider: "openrouter", effortLevels: ["low", "medium", "high"]),
        .init(id: "or-deepseek-v4-pro", label: "DeepSeek V4 Pro (OpenRouter)", provider: "openrouter", effortLevels: ["low", "medium", "high"]),
        .init(id: "or-qwen2.5-vl-72b", label: "Qwen 2.5 VL 72B (OpenRouter)", provider: "openrouter"),
        .init(id: "xai-grok-4.20", label: "Grok 4.20 (xAI direct)", provider: "xai"),
    ]

    private let interactiveStreamQueue = DispatchQueue(
        label: "com.almatraders.erp.agent.preview-stream", qos: .userInitiated)
    private var interactiveStreamStopped = false
    static var scenario: String? {
        let process = ProcessInfo.processInfo
        if let value = process.environment["ALMA_MERGE_MOCK"], !value.isEmpty { return value }
        return process.arguments.first(where: { $0.hasPrefix("ALMA_MERGE_MOCK=") })?
            .split(separator: "=", maxSplits: 1).last.map(String.init)
    }

    private static func imageSelectionFixture(
        selectedModel: String, requestedImages: Int, maxPaidGenerations: Int
    ) -> [String: Any] {
        func quote(_ model: String, provider: String, unit: Double, size: String) -> [String: Any] {
            let minimum = unit * Double(requestedImages)
            return [
                "version": 1, "currency": "USD", "kind": "provider_render_estimate",
                "model": model, "provider": provider, "quality": "standard",
                "imageSize": size, "requestedImages": requestedImages,
                "unitPriceUsd": unit, "minCostUsd": minimum,
                "maxCostUsd": minimum * Double(maxPaidGenerations),
                "maxPaidGenerationsPerImage": maxPaidGenerations,
                "pricingBasis": "internal_list_estimate",
                "pricingLastVerifiedAt": "2026-08-11",
                "excludes": ["qc_vision", "taxes", "provider_credits"],
            ]
        }
        let flash = quote("gemini-3.1-flash-image", provider: "gemini", unit: 0.101, size: "2K")
        let pro = quote("gemini-3-pro-image", provider: "gemini", unit: 0.24, size: "4K")
        let gpt = quote("gpt-image-2", provider: "openai", unit: 0.05, size: "2K")
        let options: [[String: Any]] = [
            ["id": "gemini-3.1-flash-image", "label": "Nano Banana 2",
             "provider": "gemini", "enabled": true, "quote": flash],
            ["id": "gemini-3-pro-image", "label": "Nano Banana Pro",
             "provider": "gemini", "enabled": true, "quote": pro],
            ["id": "gpt-image-2", "label": "GPT Image 2",
             "provider": "openai", "enabled": true, "quote": gpt],
            ["id": "seedream-5.0-pro", "label": "Seedream 5 Pro",
             "provider": "fal", "enabled": false,
             "unavailableReason": "এই aspect ratio-তে provider এখন unavailable"],
        ]
        let selectedQuote = selectedModel == "gpt-image-2" ? gpt
            : selectedModel == "gemini-3.1-flash-image" ? flash : pro
        return ["selectedModel": selectedModel, "options": options, "quote": selectedQuote]
    }

    override class func canInit(with request: URLRequest) -> Bool {
        scenario != nil && request.url?.path.hasPrefix("/api/assistant/") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let scenario = Self.scenario else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let path = url.path
        if scenario == "rich-output", path == "/api/assistant/files" {
            let requestedPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "path" })?.value
            let filename = requestedPath?.split(separator: "/").last.map(String.init) ?? ""
            let index = filename
                .replacingOccurrences(of: "rich-image-", with: "")
                .split(separator: ".").first.flatMap { Int($0) }
            guard let requestedPath, requestedPath == "fixture/rich-image-\(index ?? 0).jpg",
                  let index, (1...3).contains(index) else {
                respond(status: 404, json: ["error": "unknown_rich_image_ref"])
                return
            }
            let root = FileManager.default.temporaryDirectory
            let source = root.appendingPathComponent("alma-rich-output-\(index).png")
            let refreshed = root.appendingPathComponent("alma-rich-output-resigned-\(index).png")
            do {
                try Data(contentsOf: source).write(to: refreshed, options: .atomic)
                respond(status: 200, object: ["url": refreshed.absoluteString])
            } catch {
                respond(status: 500, json: ["error": "rich_image_resign_fixture_failed"])
            }
            return
        }
        if scenario == "claudeInteractive" {
            #if targetEnvironment(simulator)
            handleClaudeInteractive(path: path)
            #else
            respond(status: 503, json: ["error": "interactive_preview_is_simulator_only"])
            #endif
            return
        }
        if scenario == "streamEOF" {
            if path == "/api/assistant/chat" {
                // Reproduce the owner-hit failure exactly: the direct stream sends
                // addressability + partial prose, then ends cleanly without a
                // terminal event while the same server turn remains alive.
                let frames = [
                    "data: {\"type\":\"conversation_id\",\"id\":\"fixture-eof-conversation\"}\n\n",
                    "data: {\"type\":\"turn_id\",\"id\":\"fixture-eof-turn\"}\n\n",
                    "data: {\"type\":\"thinking_delta\",\"delta\":\"উত্তর প্রস্তুত করছি…\"}\n\n",
                    "data: {\"type\":\"text_delta\",\"delta\":\"স্টক রিপোর্ট\"}\n\n",
                ].joined()
                respond(status: 200, data: Data(frames.utf8), contentType: "text/event-stream")
                return
            }
            if path.hasSuffix("/turn-status") {
                respond(status: 200, object: [
                    "status": Self.unexpectedEOFReplayServed ? "completed" : "running",
                    "turnId": "fixture-eof-turn",
                    "startedAt": ISO8601DateFormatter().string(from: Date()),
                    "continuationNeeded": false,
                ])
                return
            }
            if path.contains("/turn/fixture-eof-turn/stream") {
                Self.unexpectedEOFReplayServed = true
                let frames = [
                    "id: 0\ndata: {\"type\":\"turn_snapshot\",\"turnId\":\"fixture-eof-turn\",\"conversationId\":\"fixture-eof-conversation\",\"status\":\"running\",\"lastSeq\":0}\n\n",
                    "id: 1\ndata: {\"type\":\"thinking_delta\",\"delta\":\"উত্তর প্রস্তুত করছি…\"}\n\n",
                    "id: 2\ndata: {\"type\":\"text_delta\",\"delta\":\"স্টক রিপোর্ট প্রস্তুত — একই turn recovery থেকে উত্তর এসেছে Boss।\"}\n\n",
                    "id: 3\ndata: {\"type\":\"done\",\"messageId\":\"fixture-eof-assistant\",\"needContinue\":false}\n\n",
                ].joined()
                respond(status: 200, data: Data(frames.utf8), contentType: "text/event-stream")
                return
            }
            if path.contains("/conversations/fixture-eof-conversation/messages") {
                respond(status: 200, object: [[
                    "id": "fixture-eof-owner", "role": "user",
                    "content": [["type": "text", "text": "আজকের স্টক রিপোর্ট দাও"]],
                ], [
                    "id": "fixture-eof-assistant", "role": "assistant",
                    "content": [["type": "text",
                                 "text": "স্টক রিপোর্ট প্রস্তুত — একই turn recovery থেকে উত্তর এসেছে Boss।"]],
                ]])
                return
            }
            if path.contains("/artifacts") || path.contains("/background-turns")
                || path.contains("/open-tasks") {
                respond(status: 200, object: [])
                return
            }
        }
        if scenario == "attachmentAtomic" {
            if path == "/api/assistant/upload" {
                // Long enough for the Simulator to prove Send was tapped while
                // upload was still active. The eventual stable ref is then bound
                // to the exact clientMessageId by the production VM path.
                respond(status: 201, object: [
                    "bucket": "agent-files",
                    "path": "fixture/atomic-photo.jpg",
                    "mediaType": "image/jpeg",
                ])
                return
            }
            if path == "/api/assistant/chat" {
                let object = request.httpBody.flatMap {
                    try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                }
                let files = object?["files"] as? [[String: Any]] ?? []
                let bodyPath = files.first?["path"] as? String
                let bodyClientMessageId = object?["clientMessageId"] as? String
                // URLProtocol may receive a body-less canonical copy of a streamed
                // request. DEBUG-only headers are derived from the same ChatBody
                // immediately before JSON encoding, so the verifier remains exact.
                let pathFingerprint = bodyPath
                    ?? request.value(forHTTPHeaderField: "X-ALMA-Fixture-File-Path")
                let clientMessageId = bodyClientMessageId
                    ?? request.value(forHTTPHeaderField: "X-ALMA-Fixture-Client-Message")
                let fileCount = object == nil
                    ? Int(request.value(forHTTPHeaderField: "X-ALMA-Fixture-File-Count") ?? "0") ?? 0
                    : files.count
                let bound = fileCount == 1
                    && pathFingerprint == "fixture/atomic-photo.jpg"
                    && !(clientMessageId ?? "").isEmpty
                guard bound else {
                    respond(status: 422, json: ["error": "attachment_fingerprint_mismatch"])
                    return
                }
                let frames = [
                    "data: {\"type\":\"conversation_id\",\"id\":\"fixture-atomic-conversation\"}\n\n",
                    "data: {\"type\":\"turn_id\",\"id\":\"fixture-atomic-turn\"}\n\n",
                    "data: {\"type\":\"thinking_delta\",\"delta\":\"Attachment binding যাচাই করছি…\"}\n\n",
                    "data: {\"type\":\"text_delta\",\"delta\":\"ছবি ও বার্তা একই transaction-এ গ্রহণ হয়েছে Boss।\"}\n\n",
                    "data: {\"type\":\"done\",\"messageId\":\"fixture-atomic-assistant\",\"needContinue\":false}\n\n",
                ].joined()
                respond(status: 200, data: Data(frames.utf8), contentType: "text/event-stream")
                return
            }
            if path.contains("/conversations/fixture-atomic-conversation/messages") {
                respond(status: 200, object: [[
                    "id": "fixture-atomic-owner", "role": "user",
                    "content": [
                        ["type": "text", "text": "এই ছবির স্টক গুনে দাও"],
                        ["type": "file_ref", "bucket": "agent-files",
                         "path": "fixture/atomic-photo.jpg", "mediaType": "image/jpeg"],
                    ],
                ], [
                    "id": "fixture-atomic-assistant", "role": "assistant",
                    "content": [["type": "text",
                                 "text": "ছবি ও বার্তা একই transaction-এ গ্রহণ হয়েছে Boss।"]],
                ]])
                return
            }
            if path.contains("/open-tasks") || path.contains("/artifacts") {
                respond(status: 200, object: [])
                return
            }
        }
        if scenario == "turnRecovery" {
            if path == "/api/assistant/models" {
                respond(status: 200, object: ["defaultModelId": "auto", "models": []])
                return
            }
            if path == "/api/assistant/active-conversation" {
                respond(status: 200, object: [
                    "conversationId": "fixture-recovery-conversation",
                    "projectId": NSNull(), "modelId": NSNull(),
                ])
                return
            }
            if path.hasSuffix("/turn-status") {
                respond(status: 200, object: [
                    "status": Self.recoveryStreamServed ? "completed" : "running",
                    "turnId": "fixture-recovery-turn",
                    "startedAt": "2026-07-20T12:00:00.000Z",
                    "continuationNeeded": false,
                ])
                return
            }
            if path.contains("/turn/fixture-recovery-turn/stream") {
                Self.recoveryStreamServed = true
                let frames = [
                    "id: 0\ndata: {\"type\":\"turn_snapshot\",\"turnId\":\"fixture-recovery-turn\",\"conversationId\":\"fixture-recovery-conversation\",\"status\":\"running\",\"lastSeq\":0}\n\n",
                    "id: 1\ndata: {\"type\":\"tool_start\",\"id\":\"fixture-recovery-tool\",\"name\":\"inventory_sync\"}\n\n",
                    "id: 2\ndata: {\"type\":\"text_delta\",\"delta\":\"সংযোগ ফিরে এসেছে — আগের কাজটিই শেষ হয়েছে।\"}\n\n",
                    "id: 3\ndata: {\"type\":\"tool_end\",\"id\":\"fixture-recovery-tool\",\"success\":true,\"resultPreview\":\"exact resume complete\"}\n\n",
                    "id: 4\ndata: {\"type\":\"done\",\"messageId\":\"fixture-recovery-assistant\",\"needContinue\":false}\n\n",
                ].joined()
                respond(status: 200, data: Data(frames.utf8), contentType: "text/event-stream")
                return
            }
            if path.contains("/conversations/fixture-recovery-conversation/messages") {
                let running = !Self.recoveryStreamServed
                let timeline: [[String: Any]] = running
                    ? [["t": "tool", "id": "fixture-recovery-tool", "name": "inventory_sync"]]
                    : [["t": "tool", "id": "fixture-recovery-tool", "name": "inventory_sync",
                        "ok": true, "result": "exact resume complete"]]
                respond(status: 200, object: [[
                    "id": "fixture-recovery-owner", "role": "user",
                    "content": [["type": "text", "text": "স্টক sync চালাও"]],
                ], [
                    "id": "fixture-recovery-assistant", "role": "assistant",
                    "content": [
                        ["type": "text", "text": running
                            ? "স্টক sync চলছে…"
                            : "সংযোগ ফিরে এসেছে — আগের কাজটিই শেষ হয়েছে।"],
                        ["type": "confirm_card", "pendingActionId": "fixture-recovery-approval",
                         "summary": "পুনরুদ্ধার হওয়া অনুমোদন", "status": "pending"],
                    ],
                    "timeline": timeline,
                ]])
                return
            }
            if path.contains("/artifacts") || path.contains("/background-turns")
                || path.contains("/open-tasks") {
                respond(status: 200, object: [])
                return
            }
        }
        if scenario == "approvalLost", path.contains("/actions/"),
           (path.hasSuffix("/approve") || path.hasSuffix("/reject")) {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        if scenario == "library", path == "/api/assistant/actions/fix-image-model-action" {
            let selection = Self.imageSelectionFixture(
                selectedModel: "gpt-image-2", requestedImages: 4, maxPaidGenerations: 3)
            respond(status: 200, object: [
                "success": true, "id": "fix-image-model-action", "type": "image_gen",
                "status": "pending",
                "summary": "Image generation request (standard quality, 4 variations)\nModel: GPT Image 2",
                "imageModelSelection": selection,
            ])
            return
        }
        if scenario == "rich-output",
           path == "/api/assistant/actions/fixture-failed-image-worker/retry" {
            Self.richImageRetryCreated = true
            let selection = Self.imageSelectionFixture(
                selectedModel: "gemini-3.1-flash-image",
                requestedImages: 3, maxPaidGenerations: 1)
            respond(status: 200, object: [
                "success": true,
                "pendingActionId": "fixture-fresh-image-retry",
                "sourceActionId": "fixture-failed-image-worker",
                "idempotent": false,
                "action": [
                    "id": "fixture-fresh-image-retry", "type": "image_gen",
                    "status": "pending", "summary": "Pinned retry · 3 images",
                    "costEstimate": NSNull(), "conversationId": "fixture-rich-output",
                    "businessId": "biz-fixture", "createdAt": "2026-08-11T06:00:00.000Z",
                    "imageModelSelection": selection,
                ],
            ])
            return
        }
        if scenario == "multiApproval", path.contains("/actions/"),
           (path.hasSuffix("/approve") || path.hasSuffix("/reject")) {
            let parts = path.split(separator: "/")
            let actionId = parts.dropLast().last.map(String.init) ?? "unknown"
            Self.multiLock.lock()
            Self.multiRequestCounts[actionId, default: 0] += 1
            let firstResolution = Self.multiResolvedActionIds.insert(actionId).inserted
            Self.multiLock.unlock()
            if firstResolution { respond(status: 200, json: ["ok": true]) }
            else { respond(status: 409, json: ["error": "duplicate_resolution", "status": "approved"]) }
            return
        }
        if path.contains("/actions/") && (path.hasSuffix("/approve") || path.hasSuffix("/reject")) {
            if scenario == "approval410" {
                respond(status: 410, json: ["error": "expired"])
            } else if scenario == "opinionFailure" {
                respond(status: 503, json: ["error": "fixture_failure"])
            } else {
                let decided = path.hasSuffix("/reject") ? "rejected" : "approved"
                respond(status: 409, json: ["error": "already_resolved", "status": decided])
            }
            return
        }
        if path.contains("/ask-cards/") && path.hasSuffix("/answer") {
            if scenario == "askFailure" {
                respond(status: 503, json: ["error": "fixture_failure"])
            } else {
                respond(status: 409, json: ["error": "already_answered", "selectedOption": "স্টক অর্ডার"])
            }
            return
        }
        if path.contains("/messages") {
            if scenario == "rich-output", Self.richImageRetryCreated {
                let selection = Self.imageSelectionFixture(
                    selectedModel: "gemini-3.1-flash-image",
                    requestedImages: 3, maxPaidGenerations: 1)
                // Reconcile the canonical assistant row that already owns the
                // failed card. A different synthetic message id would leave
                // both the live fixture row and this cold-history row mounted,
                // producing a duplicate retry control that production history
                // never returns for the same pendingActionId.
                respond(status: 200, object: [[
                    "id": "rich-answer", "role": "assistant",
                    "tokensIn": 24800, "tokensOut": 1320, "costUsd": 0.051,
                    "content": [[
                        "type": "confirm_card",
                        "pendingActionId": "fixture-failed-image-worker",
                        "summary": "Generate three ALMA campaign images from the saved checkpoint",
                        "status": "failed", "actionType": "image_gen",
                        "failReason": "Provider render শেষ করতে পারেনি",
                        "imageModelSelection": selection,
                    ], [
                        "type": "confirm_card",
                        "pendingActionId": "fixture-fresh-image-retry",
                        "summary": "Pinned retry · 3 images",
                        "status": "pending", "actionType": "image_gen",
                        "imageModelSelection": selection,
                    ]],
                ]])
                return
            }
            if scenario == "multiApproval" {
                Self.multiLock.lock()
                let resolved = Self.multiResolvedActionIds
                let counts = Self.multiRequestCounts
                Self.multiLock.unlock()
                let cards: [[String: Any]] = (1...3).map { index in
                    let actionId = "fix-approval-\(index)"
                    let duplicate = counts[actionId, default: 0] > 1
                    return [
                        "type": "confirm_card", "pendingActionId": actionId,
                        "summary": duplicate ? "DUPLICATE REQUEST \(index)" : "অনুমোদন \(index)",
                        "status": resolved.contains(actionId) ? "approved" : "pending",
                    ]
                }
                respond(status: 200, object: [[
                    "id": "fix-a-multi", "role": "assistant", "content": cards,
                ]])
                return
            }
            if scenario == "askFailure" {
                let rows: [[String: Any]] = [[
                    "id": "fix-a-parity", "role": "assistant",
                    "content": [[
                        "type": "ask_card", "askCardId": "fix-ask-askFailure",
                        "question": "কোন রিপোর্ট format দরকার Boss?",
                        "options": ["PDF", "Markdown", "দুটোই"], "status": "pending",
                    ]],
                ]]
                respond(status: 200, object: rows)
                return
            }
            let status = scenario == "approval410" ? "expired"
                : (scenario == "opinionFailure" ? "pending" : "approved")
            let rows: [[String: Any]] = [[
                "id": "fix-a-parity", "role": "assistant",
                "content": [[
                    "type": "confirm_card", "pendingActionId": "fix-approval-\(scenario)",
                    "summary": "Merge readiness approval", "status": status,
                ]],
            ]]
            respond(status: 200, object: rows)
            return
        }
        respond(status: 503, json: ["error": "unhandled_merge_fixture", "path": path])
    }

    override func stopLoading() {
        interactiveStreamQueue.async { [weak self] in
            self?.interactiveStreamStopped = true
        }
    }

    private func handleClaudeInteractive(path: String) {
        let method = request.httpMethod ?? "GET"
        if method == "GET", path == "/api/assistant/models" {
            respond(status: 200, object: [
                "defaultModelId": "claude-sonnet-4-6",
                "models": Self.interactivePreviewModels.map(\.json),
            ])
            return
        }

        if method == "GET", path == "/api/assistant/usage" {
            let selected = Self.currentInteractiveSelectedModel()
            let resolved = selected == "auto" ? "claude-sonnet-4-6" : selected
            let model = Self.interactivePreviewModels.first(where: { $0.id == resolved })
                ?? Self.interactivePreviewModels[0]
            let used = 24_800
            let percentage = Double(used) / Double(model.contextWindow) * 100
            respond(status: 200, object: [
                "checkedAt": "2026-08-09T12:00:00.000Z",
                "selectedModelId": selected,
                "resolvedModelId": resolved,
                "model": [
                    "id": selected,
                    "label": selected == "auto" ? "Auto" : model.label,
                    "resolvedLabel": model.label,
                    "contextWindow": model.contextWindow,
                    "auto": selected == "auto",
                ],
                "context": [
                    "usedTokens": used,
                    "percentage": percentage,
                    "source": "provider_round",
                    "measuredAt": "2026-08-09T11:59:58.000Z",
                    "exact": true,
                    "breakdown": [[
                        "id": "conversation",
                        "label": "Conversation",
                        "tokens": used,
                        "percentage": percentage,
                        "color": "blue",
                    ]],
                ],
            ])
            return
        }

        if method == "PATCH", path == "/api/assistant/conversations/fixture-claude-chat" {
            if let body = requestJSON(), let selected = body["modelId"] as? String {
                Self.setInteractiveSelectedModel(selected)
            }
            // Thinking level: the fixture stores it exactly like the model pick, so
            // a preview run proves the whole round-trip (tap → PATCH → pill), not
            // just that the menu renders.
            if let body = requestJSON(), let level = body["effortLevel"] as? String {
                Self.setInteractiveSelectedEffort(level)
            }
            // One response intentionally satisfies both callers on this route:
            // selectModel decodes AgentConversation; permission mode decodes OkResponse.
            respond(status: 200, object: [
                "ok": true,
                "id": "fixture-claude-chat",
                "title": "Sales recovery research",
                "modelId": Self.currentInteractiveSelectedModel(),
                "effortLevel": Self.currentInteractiveSelectedEffort() as Any,
                "permissionMode": "standard",
            ])
            return
        }

        if method == "POST", path == "/api/assistant/chat" {
            let turn = Self.nextInteractiveTurn()
            let selected = request.value(forHTTPHeaderField: "X-ALMA-Preview-Model")
                ?? Self.currentInteractiveSelectedModel()
            let prompt = Self.decodePreviewPrompt(
                request.value(forHTTPHeaderField: "X-ALMA-Preview-Prompt"))
            respondInteractiveStream(
                frames: Self.interactivePreviewFrames(
                    modelId: selected, prompt: prompt, turn: turn))
            return
        }

        if method == "GET", path.contains("/conversations/fixture-claude-chat/messages") {
            // The production merge deliberately preserves a richer local streamed
            // tail when the server page is thinner. An empty page therefore proves
            // that exact convergence behavior without manufacturing a second row.
            respond(status: 200, object: [])
            return
        }

        if method == "GET", path == "/api/assistant/conversations/fixture-claude-chat/artifacts" {
            respond(status: 200, object: [[
                "id": "claude-action-plan",
                "messageId": "claude-flow-answer",
                "type": "markdown",
                "title": "৩০ দিনের Sales Recovery Plan.md",
                "content": "# Simulator Action Plan\n\n- [ ] প্রথম priority ঠিক করুন\n- [ ] owner ও deadline দিন\n- [ ] ৭ দিন পর result review করুন",
                "version": 1,
                "createdAt": "2026-08-09T09:30:14.000Z",
            ]])
            return
        }

        if path.contains("/cancel") || path.contains("/stop") {
            respond(status: 200, object: ["ok": true])
            return
        }

        respond(status: 503, json: ["error": "unhandled_interactive_preview", "path": path])
    }

    private func requestJSON() -> [String: Any]? {
        guard let data = request.httpBody else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static var interactiveSelectedEffort: String?
    private static func setInteractiveSelectedEffort(_ level: String) {
        interactiveSelectedEffort = (level == "auto" || level.isEmpty) ? nil : level
    }
    private static func currentInteractiveSelectedEffort() -> String? { interactiveSelectedEffort }

    private static func setInteractiveSelectedModel(_ modelId: String) {
        interactiveLock.lock(); defer { interactiveLock.unlock() }
        interactiveSelectedModelId = modelId
    }

    private static func currentInteractiveSelectedModel() -> String {
        interactiveLock.lock(); defer { interactiveLock.unlock() }
        return interactiveSelectedModelId
    }

    private static func nextInteractiveTurn() -> Int {
        interactiveLock.lock(); defer { interactiveLock.unlock() }
        interactiveTurnCounter += 1
        return interactiveTurnCounter
    }

    private static func decodePreviewPrompt(_ encoded: String?) -> String {
        guard let encoded, let data = Data(base64Encoded: encoded),
              let text = String(data: data, encoding: .utf8) else {
            return "আপনার নতুন প্রশ্ন"
        }
        let compact = text.replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return compact.isEmpty ? "আপনার নতুন প্রশ্ন" : String(compact.prefix(180))
    }

    static func interactivePreviewFrames(modelId: String, prompt: String,
                                         turn: Int = 1) -> [InteractivePreviewFrame] {
        let routed = modelId == "auto" ? "gemini-3.1-pro" : modelId
        let model = interactivePreviewModels.first(where: { $0.id == routed })
            ?? interactivePreviewModels[0]
        let prefix = "preview-\(turn)"
        let safePrompt = prompt.isEmpty ? "আপনার নতুন প্রশ্ন" : String(prompt.prefix(180))
        let final = """
        ## Simulator demo সম্পন্ন

        **আপনার প্রশ্ন:** \(safePrompt)

        এটি \(model.label)-এর UI contract দেখানোর জন্য local deterministic response। কোনো production business data পড়া বা পরিবর্তন করা হয়নি।

        ### Action plan

        1. প্রথমে সবচেয়ে গুরুত্বপূর্ণ signal যাচাই করুন
        2. owner ও deadline-সহ কাজ ভাগ করুন
        3. ৭ দিন পর measurable result review করুন
        """
        return [
            .init(delayMilliseconds: 0, event: [
                "type": "conversation_id", "id": "fixture-claude-chat"]),
            .init(delayMilliseconds: 70, event: [
                "type": "turn_id", "id": "\(prefix)-turn"]),
            .init(delayMilliseconds: 150, event: [
                "type": "model_info", "label": model.label, "displayName": model.label]),
            .init(delayMilliseconds: 420, event: [
                "type": "thinking_delta",
                "delta": "প্রশ্নের উদ্দেশ্য বুঝছি: \(safePrompt)।\n"]),
            .init(delayMilliseconds: 920, event: [
                "type": "thinking_delta",
                "delta": "এটি offline Simulator, তাই real data claim না করে demo evidence ও action flow দেখাতে হবে।"]),
            .init(delayMilliseconds: 1_350, event: [
                "type": "text_delta",
                "delta": "Boss, বুঝেছি। আগে প্রশ্নটাকে সংক্ষেপে যাচাই করছি, তারপর relevant signals দেখে practical action plan দেব।"]),
            .init(delayMilliseconds: 1_420, event: [
                "type": "preamble",
                "text": "Boss, বুঝেছি। আগে প্রশ্নটাকে সংক্ষেপে যাচাই করছি, তারপর relevant signals দেখে practical action plan দেব।"]),
            .init(delayMilliseconds: 1_780, event: [
                "type": "progress_update", "label": "প্রয়োজনীয় business signals খুঁজছে"]),
            .init(delayMilliseconds: 2_050, event: [
                "type": "tool_start", "id": "\(prefix)-sales", "name": "get_sales_overview",
                "input": ["range": "last_90_days", "source": "simulator_demo"]]),
            .init(delayMilliseconds: 2_430, event: [
                "type": "tool_end", "id": "\(prefix)-sales", "success": true,
                "resultPreview": "Demo revenue trend loaded; no production records queried."]),
            .init(delayMilliseconds: 2_620, event: [
                "type": "tool_start", "id": "\(prefix)-customers", "name": "get_customer_segments",
                "input": ["segments": ["new", "repeat"], "source": "simulator_demo"]]),
            .init(delayMilliseconds: 2_980, event: [
                "type": "tool_end", "id": "\(prefix)-customers", "success": true,
                "resultPreview": "Demo customer cohorts compared successfully."]),
            .init(delayMilliseconds: 3_350, event: [
                "type": "text_delta",
                "delta": "প্রথম pass-এ signals পাওয়া গেছে। এখন channel impact ও execution priority মিলিয়ে final recommendation বানাচ্ছি।"]),
            .init(delayMilliseconds: 3_780, event: [
                "type": "thinking_delta",
                "delta": "প্রথম finding-কে final ধরে না নিয়ে channel efficiency ও impact overlap দিয়ে cross-check করা দরকার।"]),
            .init(delayMilliseconds: 4_160, event: [
                "type": "progress_update", "label": "findings cross-check করছে"]),
            .init(delayMilliseconds: 4_410, event: [
                "type": "tool_start", "id": "\(prefix)-channel", "name": "analyze_channel_performance",
                "input": ["channels": ["paid", "organic", "direct"], "source": "simulator_demo"]]),
            .init(delayMilliseconds: 4_760, event: [
                "type": "tool_end", "id": "\(prefix)-channel", "success": true,
                "resultPreview": "Demo channel performance cross-check complete."]),
            .init(delayMilliseconds: 4_940, event: [
                "type": "tool_start", "id": "\(prefix)-impact", "name": "find_stockout_impact",
                "input": ["join": ["inventory", "orders"], "source": "simulator_demo"]]),
            .init(delayMilliseconds: 5_280, event: [
                "type": "tool_end", "id": "\(prefix)-impact", "success": true,
                "resultPreview": "Demo impact overlap verified; no live inventory accessed."]),
            .init(delayMilliseconds: 5_690, event: [
                "type": "text_delta", "delta": final]),
            .init(delayMilliseconds: 6_080, event: [
                "type": "artifact_saved", "id": "claude-action-plan",
                "title": "৩০ দিনের Sales Recovery Plan.md", "artifactType": "markdown"]),
            .init(delayMilliseconds: 6_350, event: [
                "type": "done", "messageId": "\(prefix)-assistant",
                "tokensIn": 1_280, "tokensOut": 620, "cacheRead": 420,
                "costUsd": 0.0042, "needContinue": false, "apiRounds": 4,
                "roundCostsUsd": [0.0010, 0.0011, 0.0010, 0.0011]]),
        ]
    }

    private func respondInteractiveStream(frames: [InteractivePreviewFrame]) {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        let payloads: [(delay: Int, data: Data)] = frames.compactMap { frame in
            guard let json = try? JSONSerialization.data(withJSONObject: frame.event),
                  let line = String(data: json, encoding: .utf8) else { return nil }
            return (frame.delayMilliseconds, Data("data: \(line)\n\n".utf8))
        }
        guard payloads.count == frames.count else {
            respond(status: 500, json: ["error": "interactive_preview_encoding_failed"])
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream",
                           "Cache-Control": "no-cache"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for (index, payload) in payloads.enumerated() {
            interactiveStreamQueue.asyncAfter(
                deadline: .now() + .milliseconds(payload.delay)) { [weak self] in
                    guard let self, !self.interactiveStreamStopped else { return }
                    self.client?.urlProtocol(self, didLoad: payload.data)
                    if index == payloads.count - 1 {
                        self.client?.urlProtocolDidFinishLoading(self)
                        self.interactiveStreamStopped = true
                    }
                }
        }
    }

    private func respond(status: Int, json: [String: Any]) { respond(status: status, object: json) }
    private func respond(status: Int, object: Any) {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        respond(status: status, data: data, contentType: "application/json")
    }
    private func respond(status: Int, data: Data, contentType: String) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": contentType])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
#endif

// MARK: - Errors

enum AlmaAPIError: LocalizedError {
    /// Session cookies missing/expired — the owner must log in again in the web tab.
    case notAuthenticated
    /// Server answered with a non-2xx status; body kept (truncated) for debugging.
    case http(status: Int, body: String)
    /// 2xx received but the JSON didn't match the expected shape.
    case decoding(Error)
    /// Network-level failure (offline, timeout, DNS…).
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Not logged in — open the app's web tab and sign in again."
        case .http(let status, let body):
            return "Server error \(status): \(body.prefix(200))"
        case .decoding(let err):
            return "Unexpected response format: \(err.localizedDescription)"
        case .transport(let err):
            return err.localizedDescription
        }
    }
}

// MARK: - AnyEncodable

/// Type-erased Encodable so callers can pass heterogenous dictionaries as bodies,
/// e.g. `["status": AnyEncodable("done"), "qty": AnyEncodable(3)]`, without defining
/// a Codable struct for every tiny PATCH.
struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init<E: Encodable>(_ value: E) {
        encodeClosure = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}

// MARK: - AlmaAPI


/// Which deployment the app talks to.
///
/// The demo is a separate deployment with its own database of invented data, handed
/// out so someone can try the app without seeing a real order or a real salary. The
/// app follows the account: sign in with a `@alma-erp.demo` address and everything —
/// native screens, web tabs, the WebView shell — points at the demo instead.
///
/// Stored rather than derived at each launch, so a demo tester's next cold start
/// comes back to the demo rather than to a production login they cannot pass.
enum AlmaBackend: String {
    case production
    case demo

    private static let defaultsKey = "alma.backend"
    static let demoEmailSuffix = "@alma-erp.demo"

    var host: String {
        switch self {
        case .production: return "alma-erp-six.vercel.app"
        case .demo: return "alma-erp-demo.vercel.app"
        }
    }

    var url: URL { URL(string: "https://\(host)")! }

    /// The backend the owner actually signed in to, or nil when nobody has yet.
    /// Nil matters: a fresh install must still honour a build-time pin, while an
    /// explicit demo sign-in has to override it — the shipped Info.plist carries
    /// `ALMABaseURL` pointing at production, so a build override that always won
    /// would make the demo switch unreachable.
    static var storedChoice: AlmaBackend? {
        AlmaBackend(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "")
    }

    static var current: AlmaBackend {
        get { storedChoice ?? .production }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }

    /// The backend a login identifier belongs to. Demo accounts are the only ones
    /// that exist on the demo instance, so the address is the whole signal.
    static func forLogin(identifier: String) -> AlmaBackend {
        identifier.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasSuffix(demoEmailSuffix) ? .demo : .production
    }

    /// Switches backend if needed, dropping cookies so a session for one host is
    /// never presented to the other. Returns true when the backend actually changed.
    /// Posted after the backend actually changed, so the shell can drop the page it
    /// is showing and reload against the new host.
    static let didChangeNotification = Notification.Name("almaBackendDidChange")

    @discardableResult
    static func select(_ backend: AlmaBackend) -> Bool {
        guard backend != storedChoice else { return false }
        current = backend

        let store = HTTPCookieStorage.shared
        store.cookies?.forEach { store.deleteCookie($0) }
        // WebKit keeps its own jar. Clearing only the shared storage left the other
        // host's session behind, and `AlmaAPI.syncCookies()` copies WebKit's cookies
        // back into the shared store — so the old session would return by itself.
        let webStore = WKWebsiteDataStore.default().httpCookieStore
        webStore.getAllCookies { cookies in
            for cookie in cookies { webStore.delete(cookie, completionHandler: nil) }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: AlmaBackend.didChangeNotification, object: nil)
            }
        }
        return true
    }
}

final class AlmaAPI: NSObject {

    static let shared = AlmaAPI()

    /// Build-time override for physical-device preview verification. Wins over the
    /// backend selection below, so a preview build stays pinned where it was aimed.
    private static let buildOverride: URL? = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "ALMABaseURL") as? String else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard trimmed.hasPrefix("https://") else { return nil }
        return URL(string: trimmed)
    }()

    /// Production unless the owner signed in with a demo account — see `AlmaBackend`.
    /// Computed rather than stored: signing in switches it mid-session, and every
    /// screen reads through here.
    static var baseURL: URL {
        // An explicit sign-in wins; otherwise a build-time pin; otherwise production.
        if let chosen = AlmaBackend.storedChoice { return chosen.url }
        return buildOverride ?? AlmaBackend.production.url
    }

    /// Posted (on main) when a request came back unauthenticated even after a cookie
    /// re-sync — the UI should prompt the owner to log in via the web tab.
    static let authExpiredNotification = Notification.Name("almaAuthExpired")

    /// Re-sync cookies from WKWebView at most this often; a forced sync happens anyway
    /// on the retry path, so a short staleness window is harmless.
    private static let cookieSyncInterval: TimeInterval = 30

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()

    /// Guarded by `syncLock` — requests can arrive from any task/thread.
    private var lastCookieSync: Date?
    private let syncLock = NSLock()

    private override init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        // Default config uses HTTPCookieStorage.shared — the target of syncCookies().
        config.httpShouldSetCookies = true
        config.httpAdditionalHeaders = [
            "Accept": "application/json",
            // Some Next.js middleware branches on this to answer JSON instead of HTML.
            "X-Requested-With": "XMLHttpRequest",
        ]
        #if DEBUG
        if AlmaMergeReadinessURLProtocol.scenario != nil {
            config.protocolClasses = [AlmaMergeReadinessURLProtocol.self]
        }
        #endif

        // Delegate-based session so we can refuse redirect-following (see extension below):
        // a 307 → /login must reach our status check, not be transparently followed.
        let delegate = RedirectBlocker()
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        let d = JSONDecoder()
        d.dateDecodingStrategy = AlmaAPI.tolerantDateStrategy
        decoder = d // keys stay camelCase — the API is JS camelCase already

        super.init()
    }

    // MARK: Cookie bridge

    /// Copies every cookie from the shared WKWebsiteDataStore into HTTPCookieStorage.shared
    /// so URLSession sends the same session as the web views. WKHTTPCookieStore is a
    /// main-thread API with a completion handler — hop to main and bridge to async.
    ///
    /// BOUNDED (2026-07-15): the callback answers through WebKit's own processes;
    /// when they are broken (seen live: iOS 26 sim after a Simulator-host restart)
    /// it simply NEVER calls back, and every send() hung forever before its request
    /// — before the first-event watchdog could even start. On timeout we proceed
    /// with the cookies already in HTTPCookieStorage: a stale copy still sends the
    /// request (worst case a 401 → the normal re-auth path); a hang sends nothing.
    func syncCookies() async {
        let cookies = await Self.wkCookies(timeout: 3)
        guard let cookies else { return }   // timed out — keep cached cookies, retry next call
        let storage = HTTPCookieStorage.shared
        for cookie in cookies {
            storage.setCookie(cookie)
        }
        setLastSync(Date())
    }

    private static func wkCookies(timeout seconds: TimeInterval) async -> [HTTPCookie]? {
        final class Once: @unchecked Sendable {
            private let lock = NSLock()
            private var fired = false
            func claim() -> Bool {
                lock.lock(); defer { lock.unlock() }
                if fired { return false }
                fired = true
                return true
            }
        }
        let once = Once()
        return await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                WKWebsiteDataStore.default().httpCookieStore.getAllCookies { all in
                    if once.claim() { continuation.resume(returning: all) }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
                if once.claim() { continuation.resume(returning: nil) }
            }
        }
    }

    /// Forget the last sync time so the very next request re-copies cookies first.
    /// Call after anything that may have changed the web session (login, logout).
    func invalidateCookieCache() {
        setLastSync(nil)
    }

    /// Lazy sync: only hit the (main-thread) WK cookie store when the copy is stale.
    private func syncCookiesIfStale() async {
        if let last = lastSync(), Date().timeIntervalSince(last) < Self.cookieSyncInterval { return }
        await syncCookies()
    }

    // Synchronous lock helpers — NSLock must not be held across (or called from)
    // async suspension contexts, so the critical sections live in sync functions.
    private func lastSync() -> Date? {
        syncLock.lock(); defer { syncLock.unlock() }
        return lastCookieSync
    }
    private func setLastSync(_ date: Date?) {
        syncLock.lock(); defer { syncLock.unlock() }
        lastCookieSync = date
    }

    // MARK: Public requests

    /// GET a JSON endpoint. Nil query values are skipped, so callers can pass
    /// optional filters straight through: `get("/api/orders", query: ["status": filter])`.
    ///
    /// IOSP-3: concurrent identical GETs are coalesced into one wire round-trip
    /// (single-flight). No TTL caching here — every distinct call still fetches;
    /// use `getCached` to opt a read-only screen into a freshness window.
    func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        let key = AlmaRequestCache.key(method: "GET", path: path, query: query)
        let request = makeRequest(method: "GET", path: path, query: query, bodyData: nil)
        let data = try await AlmaRequestCache.shared.singleFlight(key: key) { [self] in
            try await perform(request: request)
        }
        return try decode(data)
    }

    /// GET for OWNER-ONLY feeds a staff session may legitimately hit (e.g. the
    /// live dock's poll). A 403 there means "not for you", not "logged out" —
    /// posting `authExpiredNotification` would flash the login banner at a
    /// perfectly valid staff session (Codex P2). Auth failures still throw
    /// `.notAuthenticated`; the caller stops itself, the UI stays quiet.
    func getQuietAuth<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        let key = AlmaRequestCache.key(method: "GET", path: path, query: query)
        let request = makeRequest(method: "GET", path: path, query: query, bodyData: nil)
        let data = try await AlmaRequestCache.shared.singleFlight(key: key) { [self] in
            try await perform(request: request, notifyOnAuthFailure: false)
        }
        return try decode(data)
    }

    /// IOSP-3: GET with an opt-in TTL. Within `ttl` seconds a warm re-navigation
    /// returns the cached bytes with ZERO refetch; after it, one fresh fetch (also
    /// single-flighted). For READ-ONLY resources only — never approvals/mutations,
    /// which go through `send` and clear this cache. `ttl` is per-resource; keep it
    /// short (a few seconds) for anything that changes often.
    func getCached<T: Decodable>(_ path: String, query: [String: String?] = [:],
                                 ttl: TimeInterval) async throws -> T {
        let key = AlmaRequestCache.key(method: "GET", path: path, query: query)
        let request = makeRequest(method: "GET", path: path, query: query, bodyData: nil)
        let data = try await AlmaRequestCache.shared.cached(key: key, ttl: ttl) { [self] in
            try await perform(request: request)
        }
        return try decode(data)
    }

    /// POST / PATCH / DELETE with an optional JSON body.
    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        var bodyData: Data?
        if let body {
            do { bodyData = try encoder.encode(body) } catch { throw AlmaAPIError.decoding(error) }
        }
        let data = try await perform(request: makeRequest(method: method, path: path, query: [:], bodyData: bodyData))
        await AlmaRequestCache.shared.invalidateAll() // IOSP-3: a write must never be masked by a stale read
        return try decode(data)
    }

    /// Body-less variant so `send("DELETE", "/api/x")` compiles without spelling a generic.
    func send<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        try await send(method, path, body: Optional<AnyEncodable>.none)
    }

    /// Mutations such as DELETE that intentionally return HTTP 204. `perform`
    /// still validates auth/status; only the impossible JSON decode is skipped.
    func sendNoContent(_ method: String, _ path: String) async throws {
        _ = try await perform(request: makeRequest(method: method, path: path, query: [:], bodyData: nil))
        await AlmaRequestCache.shared.invalidateAll()
    }

    /// POST/PATCH with query params (some routes read searchParams on writes —
    /// e.g. POST /api/settings/telegram-ops/health?business_id=…). Additive, S9.
    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String,
                                          query: [String: String?], body: B?) async throws -> T {
        var bodyData: Data?
        if let body {
            do { bodyData = try encoder.encode(body) } catch { throw AlmaAPIError.decoding(error) }
        }
        let data = try await perform(request: makeRequest(method: method, path: path, query: query, bodyData: bodyData))
        await AlmaRequestCache.shared.invalidateAll() // IOSP-3: a write must never be masked by a stale read
        return try decode(data)
    }

    /// Raw bytes for debugging (`String(data:encoding:)` it to eyeball a payload).
    func getRaw(_ path: String) async throws -> Data {
        try await perform(request: makeRequest(method: "GET", path: path, query: [:], bodyData: nil))
    }

    // MARK: Core pipeline

    private func makeRequest(method: String, path: String, query: [String: String?], bodyData: Data?) -> URLRequest {
        var components = URLComponents(url: Self.baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components.queryItems = items }

        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// One request with the auth-retry loop: stale-cookie check → attempt →
    /// on auth failure force a fresh cookie copy and try exactly once more.
    /// `notifyOnAuthFailure: false` keeps a terminal auth failure SILENT (no
    /// login banner) for callers polling owner-only feeds from staff sessions.
    private func perform(request: URLRequest, notifyOnAuthFailure: Bool = true) async throws -> Data {
        let decision = Self.approvalPetDecision(for: request)
        let reactionId: UUID? = await MainActor.run {
            guard let decision,
                  UIApplication.shared.applicationState == .active
            else { return nil }
            return GlobalOfficeRobotStore.shared.beginApprovalReaction(decision)
        }

        do {
            await syncCookiesIfStale()

            let (data, response) = try await attempt(request)
            if !Self.looksUnauthenticated(response) {
                let accepted = try validated(data, response)
                await finishApprovalPetReaction(
                    reactionId,
                    decision: decision,
                    succeeded: true
                )
                return accepted
            }

            // First attempt bounced — the URLSession copy of the cookies may simply be
            // older than the web session (Supabase rotates tokens). Re-copy and retry once.
            invalidateCookieCache()
            await syncCookies()

            let (retryData, retryResponse) = try await attempt(request)
            if Self.looksUnauthenticated(retryResponse) {
                // Genuinely logged out — tell the UI layer so it can surface the login flow.
                if notifyOnAuthFailure {
                    await MainActor.run {
                        NotificationCenter.default.post(name: Self.authExpiredNotification, object: nil)
                    }
                }
                throw AlmaAPIError.notAuthenticated
            }
            let accepted = try validated(retryData, retryResponse)
            await finishApprovalPetReaction(
                reactionId,
                decision: decision,
                succeeded: true
            )
            return accepted
        } catch {
            await finishApprovalPetReaction(
                reactionId,
                decision: decision,
                succeeded: false
            )
            throw error
        }
    }

    private func finishApprovalPetReaction(
        _ id: UUID?,
        decision: GlobalOfficeRobotStore.ApprovalDecision?,
        succeeded: Bool
    ) async {
        guard let id, let decision else { return }
        await MainActor.run {
            GlobalOfficeRobotStore.shared.finishApprovalReaction(
                id: id,
                decision: decision,
                succeeded: succeeded
            )
        }
    }

    /// Detects only explicit approval mutations. Ordinary writes must never make
    /// the Robot celebrate. Native approval flows use either a semantic endpoint
    /// suffix (`.../approve|reject`) or an explicit `action` / `decision` field.
    /// Keeping the classifier here covers Agent cards, ERP approvals, attendance
    /// reviews, payroll wallet requests, and future native approval screens that
    /// follow the same contract without coupling the Robot to each feature view.
    private static func approvalPetDecision(
        for request: URLRequest
    ) -> GlobalOfficeRobotStore.ApprovalDecision? {
        let path = request.url?.path.lowercased() ?? ""
        let method = request.httpMethod?.uppercased() ?? ""
        let isMutation = method == "POST" || method == "PATCH" || method == "PUT"

        if isMutation {
            if path.hasSuffix("/approve") { return .approve }
            if path.hasSuffix("/reject") { return .reject }
        }

        if isMutation,
           let body = request.httpBody,
           let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            let explicitDecision = (json["action"] as? String)
                ?? (json["decision"] as? String)
            switch explicitDecision?.uppercased() {
            case "APPROVE": return .approve
            case "REJECT": return .reject
            default: break
            }
        }

        return nil
    }

    /// Single wire round-trip; transport errors wrapped, non-HTTP responses rejected.
    private func attempt(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // IOSP-0 baseline: every native API round-trip emits one api.request event
        // (path + status + ms only — never payloads), so idle request volume and
        // durations are countable from `log stream`.
        let started = Date()
        let path = request.url?.path ?? "?"
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AlmaAPIError.transport(URLError(.badServerResponse))
            }
            AlmaPerfLog.event("api.request",
                              "\(request.httpMethod ?? "GET") \(path) status=\(http.statusCode) ms=\(Int(Date().timeIntervalSince(started) * 1000))")
            return (data, http)
        } catch let error as AlmaAPIError {
            AlmaPerfLog.event("api.request", "\(request.httpMethod ?? "GET") \(path) error ms=\(Int(Date().timeIntervalSince(started) * 1000))")
            throw error
        } catch {
            AlmaPerfLog.event("api.request", "\(request.httpMethod ?? "GET") \(path) error ms=\(Int(Date().timeIntervalSince(started) * 1000))")
            throw AlmaAPIError.transport(error)
        }
    }

    /// Next.js signals "not logged in" two ways: a plain 401/403 from API routes, or a
    /// 307/302 redirect to /login from middleware. Redirects are never auto-followed
    /// (RedirectBlocker), so the 3xx + Location header is visible here.
    private static func looksUnauthenticated(_ response: HTTPURLResponse) -> Bool {
        if response.statusCode == 401 || response.statusCode == 403 { return true }
        if (300..<400).contains(response.statusCode) {
            if let location = response.value(forHTTPHeaderField: "Location"),
               location.contains("/login") {
                return true
            }
            if response.url?.path.contains("/login") == true { return true }
        }
        return false
    }

    private func validated(_ data: Data, _ response: HTTPURLResponse) throws -> Data {
        guard (200..<300).contains(response.statusCode) else {
            throw AlmaAPIError.http(
                status: response.statusCode,
                body: String(data: data, encoding: .utf8) ?? "<non-utf8 body>"
            )
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw AlmaAPIError.decoding(error)
        }
    }

    // MARK: Date decoding

    /// The ERP's JSON mixes date shapes (Postgres timestamps serialized by JS, some
    /// epoch-ms fields), so try in order: ISO8601 with fractional seconds → ISO8601
    /// plain → epoch milliseconds (JS Date.now()) → epoch seconds.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let tolerantDateStrategy = JSONDecoder.DateDecodingStrategy.custom { decoder in
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            if let date = isoFractional.date(from: string) { return date }
            if let date = isoPlain.date(from: string) { return date }
            if let ms = Double(string) { return dateFromEpoch(ms) }
        }
        if let number = try? container.decode(Double.self) {
            return dateFromEpoch(number)
        }
        throw DecodingError.dataCorrupted(DecodingError.Context(
            codingPath: decoder.codingPath,
            debugDescription: "Unrecognized date format"
        ))
    }

    /// Heuristic: anything past year ~5138 in seconds must be milliseconds.
    private static func dateFromEpoch(_ value: Double) -> Date {
        value > 100_000_000_000
            ? Date(timeIntervalSince1970: value / 1000)
            : Date(timeIntervalSince1970: value)
    }

    /// multipart/form-data upload over the SAME cookie-bridged session — so native
    /// screens can post images (office chat, proof photos) without the web escape hatch.
    func uploadMultipart<T: Decodable>(_ path: String, fileField: String, filename: String,
                                       mime: String, data fileData: Data,
                                       fields: [String: String] = [:]) async throws -> T {
        let boundary = "alma-\(UUID().uuidString)"
        var body = Data()
        func line(_ s: String) { body.append(s.data(using: .utf8)!) }
        for (k, v) in fields {
            line("--\(boundary)\r\n")
            line("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n")
            line("\(v)\r\n")
        }
        line("--\(boundary)\r\n")
        line("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\n")
        line("Content-Type: \(mime)\r\n\r\n")
        body.append(fileData)
        line("\r\n--\(boundary)--\r\n")

        var request = makeRequest(method: "POST", path: path, query: [:], bodyData: nil)
        request.httpBody = body
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let respData = try await perform(request: request)
        await AlmaRequestCache.shared.invalidateAll() // IOSP-3: uploads are writes
        return try decode(respData)
    }
}

// MARK: - Redirect blocking

/// Refuses all automatic redirect-following so a middleware 307 → /login surfaces as
/// a 3xx response (with its Location header) instead of a decoded login HTML page.
/// API JSON endpoints never legitimately redirect, so nothing is lost.
private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil) // nil = don't follow; deliver the 3xx to the caller
    }
}
