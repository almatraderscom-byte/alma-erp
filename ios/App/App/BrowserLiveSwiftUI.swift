//
//  BrowserLiveSwiftUI.swift
//  The VPS browser, live on the phone — watch it work, reach in when it gets stuck.
//
//  Mirrors the web /agent/browser-live page and talks to the same endpoints:
//    GET  /api/assistant/browser-live            status
//    POST /api/assistant/browser-live            {action: start|stop|input|tune}
//    GET  /api/assistant/browser-live/stream     SSE frames (base64 JPEG)
//
//  Two things this leans on that already exist and are proven in this app:
//  AlmaAPI's cookie bridge (WKHTTPCookieStore → HTTPCookieStorage → URLSession),
//  so a native screen is authenticated exactly like the web tab; and
//  AssistantNet.streamSession, the long-lived SSE session the chat turns use.
//
//  The stream is asked for at PHONE size. Measured on the server: a desktop frame
//  is ~120 KB and a phone frame ~39 KB, so 5 fps desktop is ~4.8 Mbit/s against
//  ~0.63 for 2 fps phone. That gap is the owner's own mobile data and battery, so
//  the phone never asks for the desktop picture.
//
import SwiftUI
import UIKit

// MARK: - Wire types

private struct LiveStreamSettings: Encodable {
    var fps: Int
    var quality: Int
    var width: Int
}

private struct LiveStartBody: Encodable {
    var action = "start"
    var startUrl: String?
    var goal: String?
    var profile: String?
    var stream: LiveStreamSettings
}

private struct LiveSimpleBody: Encodable { var action: String }

private struct LiveInputEvent: Encodable {
    var type: String
    var x: Int?
    var y: Int?
    var deltaY: Int?
    var text: String?
    var key: String?
    var url: String?
}

private struct LiveInputBody: Encodable {
    var action = "input"
    var event: LiveInputEvent
}

/// Internal, not private: the model publishes it and the view reads it.
struct LiveStatusDTO: Decodable {
    var running: Bool
    var sessionId: String?
    var goal: String?
    var paused: Bool?
    var pauseReason: String?
    var url: String?
    var profile: String?
}

/// Endpoints answer flat JSON; a start also carries an error message when refused.
private struct LiveActionResult: Decodable {
    var ok: Bool?
    var sessionId: String?
    var error: String?
    var message: String?
}

// MARK: - SSE

/// A minimal SSE reader that also reports the EVENT NAME.
///
/// AlmaSSEParser already exists and is battle-tested, but it only tracks `data`
/// and `id` — the chat stream carries its type inside the JSON. This stream names
/// its events on the wire (frame / paused / resumed / ended), and teaching the
/// shared parser a new field would mean editing the code every chat turn depends
/// on for a screen nobody has used yet. Twenty lines here is the cheaper risk.
private struct NamedSSEParser {
    private var dataLines: [String] = []
    private var eventName: String?

    mutating func consume(line rawLine: String) -> (event: String, data: String)? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }
        if line.isEmpty {
            guard !dataLines.isEmpty else { return nil }
            let payload = dataLines.joined(separator: "\n")
            let name = eventName ?? "message"
            dataLines = []
            eventName = nil
            return (name, payload)
        }
        if line.hasPrefix(":") { return nil }                     // keepalive
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }
        if field == "data" { dataLines.append(value) }
        if field == "event" { eventName = value }
        return nil
    }
}

private struct FramePayload: Decodable { var data: String }

// MARK: - Model

@MainActor
final class BrowserLiveModel: ObservableObject {
    /// Must match VIEWPORT in worker/src/browser/live-session.mjs — the page's own
    /// size, which is what input coordinates are expressed in regardless of how
    /// small a picture we asked to be sent.
    static let viewport = CGSize(width: 1280, height: 800)
    /// Measured phone shape (see the file header).
    private static let phoneStream = LiveStreamSettings(fps: 2, quality: 35, width: 720)

    @Published var status = LiveStatusDTO(running: false)
    @Published var frame: UIImage?
    @Published var error: String?
    @Published var busy = false
    @Published var startUrl = ""
    @Published var canTouch = true

    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    /// Input is serialised: each keystroke is its own request, and fired in
    /// parallel they arrive in whatever order the network settles on — typing
    /// "backlink" on the web page once landed as "kbclanki" before this was fixed
    /// there. Ordering is the entire point of a keyboard.
    private var inputChain: Task<Void, Never> = Task {}

    func onAppear() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshStatus()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    /// Leaving the screen must stop the stream. A phone that keeps pulling frames
    /// in the background is spending data and battery on a picture nobody sees.
    func onDisappear() {
        pollTask?.cancel(); pollTask = nil
        streamTask?.cancel(); streamTask = nil
    }

    func refreshStatus() async {
        do {
            let s: LiveStatusDTO = try await AlmaAPI.shared.get("/api/assistant/browser-live")
            status = s
            if s.running { startStreamIfNeeded() } else { stopStream() }
        } catch AlmaAPIError.notAuthenticated {
            error = "লগইন মেয়াদ শেষ — ওয়েব ট্যাবে আবার লগইন করুন।"
        } catch {
            self.error = "সার্ভারের সাথে যোগাযোগ করা গেল না"
        }
    }

    func start() async {
        busy = true; error = nil
        defer { busy = false }
        let url = startUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let body = LiveStartBody(startUrl: url.isEmpty ? nil : url,
                                     goal: "owner live session (phone)",
                                     profile: nil,
                                     stream: Self.phoneStream)
            let r: LiveActionResult = try await AlmaAPI.shared.send("POST", "/api/assistant/browser-live", body: body)
            if let message = r.message, r.sessionId == nil { error = message }
            await refreshStatus()
        } catch AlmaAPIError.http(_, let body) {
            // The commonest refusal is "a call is in progress" — that is an answer,
            // not a failure, so it is shown as the server worded it.
            error = Self.messageFrom(body) ?? "ব্রাউজার খোলা গেল না"
        } catch {
            self.error = "ব্রাউজার খোলা গেল না"
        }
    }

    func stop() async {
        busy = true
        defer { busy = false }
        _ = try? await AlmaAPI.shared.send("POST", "/api/assistant/browser-live",
                                           body: LiveSimpleBody(action: "stop")) as LiveActionResult
        frame = nil
        await refreshStatus()
    }

    // MARK: Input

    func tap(at point: CGPoint, in displaySize: CGSize) {
        guard displaySize.width > 0, displaySize.height > 0 else { return }
        let x = Int((point.x / displaySize.width) * Self.viewport.width)
        let y = Int((point.y / displaySize.height) * Self.viewport.height)
        send(LiveInputEvent(type: "click", x: x, y: y))
    }

    func scroll(by deltaY: CGFloat) {
        send(LiveInputEvent(type: "scroll",
                            x: Int(Self.viewport.width / 2),
                            y: Int(Self.viewport.height / 2),
                            deltaY: Int(deltaY)))
    }

    func type(_ text: String) { send(LiveInputEvent(type: "text", text: text)) }
    func press(_ key: String) { send(LiveInputEvent(type: "key", key: key)) }

    private func send(_ event: LiveInputEvent) {
        guard canTouch, status.running else { return }
        let previous = inputChain
        inputChain = Task { [weak self] in
            _ = await previous.result                     // strict ordering
            guard let self else { return }
            do {
                _ = try await AlmaAPI.shared.send("POST", "/api/assistant/browser-live",
                                                  body: LiveInputBody(event: event)) as LiveActionResult
            } catch {
                await MainActor.run { self.error = "ইনপুট পাঠানো গেল না" }
            }
        }
    }

    // MARK: Frames

    private func startStreamIfNeeded() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            // The relay is time-boxed by the platform, so a clean end is normal —
            // reconnect rather than treating it as a failure. The session on the
            // VPS is untouched by that and keeps its page.
            while !Task.isCancelled {
                await self?.consumeStream()
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if await self?.status.running != true { break }
            }
            await MainActor.run { self?.streamTask = nil }
        }
    }

    private func stopStream() {
        streamTask?.cancel(); streamTask = nil
        frame = nil
    }

    private func consumeStream() async {
        // Same cookie bridge every other native screen uses — sync first, then let
        // URLSession carry the web login's session cookie.
        await AlmaAPI.shared.syncCookies()
        guard let url = URL(string: "/api/assistant/browser-live/stream?fps=2", relativeTo: AlmaAPI.baseURL) else { return }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (bytes, resp) = try await AssistantNet.streamSession.bytes(for: request)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }

            var parser = NamedSSEParser()
            var lineBuf: [UInt8] = []
            lineBuf.reserveCapacity(4096)
            let decoder = JSONDecoder()

            for try await byte in bytes {
                if byte == 0x0A {
                    let line = String(decoding: lineBuf, as: UTF8.self)
                    lineBuf.removeAll(keepingCapacity: true)
                    try Task.checkCancellation()
                    guard let ev = parser.consume(line: line) else { continue }
                    switch ev.event {
                    case "frame":
                        guard let d = ev.data.data(using: .utf8),
                              let payload = try? decoder.decode(FramePayload.self, from: d),
                              let jpeg = Data(base64Encoded: payload.data),
                              let image = UIImage(data: jpeg) else { continue }
                        await MainActor.run { self.frame = image }
                    case "paused", "resumed", "ended":
                        await refreshStatus()
                    default:
                        continue
                    }
                } else {
                    lineBuf.append(byte)
                }
            }
        } catch {
            // Cancellation and end-of-stream both land here; the loop above decides
            // whether to come back.
        }
    }

    private static func messageFrom(_ body: String) -> String? {
        guard let d = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return obj["message"] as? String ?? obj["error"] as? String
    }
}

// MARK: - Screen

struct BrowserLiveScreen: View {
    @StateObject private var model = BrowserLiveModel()
    @FocusState private var keyboardFocused: Bool
    @State private var typed = ""

    var body: some View {
        VStack(spacing: 12) {
            controls
            screen
            hint
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .onAppear { model.onAppear() }
        .onDisappear { model.onDisappear() }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField("https://…  (ঐচ্ছিক)", text: $model.startUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    .disabled(model.status.running || model.busy)

                Button {
                    Task { model.status.running ? await model.stop() : await model.start() }
                } label: {
                    Text(model.status.running ? "বন্ধ" : (model.busy ? "খুলছে…" : "খুলুন"))
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(model.status.running ? Color.red.opacity(0.85) : Color(red: 0.878, green: 0.478, blue: 0.372),
                                    in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(.white)
                }
                .disabled(model.busy)
            }

            Text(statusLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let error = model.error {
                Text(error).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var statusLine: String {
        guard model.status.running else {
            return "কোনো লাইভ সেশন চালু নেই। কল চলাকালে সেশন খুলবে না — কলের আওয়াজ পরিষ্কার রাখতে।"
        }
        if model.status.paused == true {
            return model.status.pauseReason == "a call is in progress"
                ? "⏸ থেমে আছে — একটা কল চলছে, কল শেষ হলে নিজেই চালু হবে"
                : "⏸ থেমে আছে — কিছুক্ষণ কোনো কাজ হয়নি; ছুঁলেই আবার চলবে"
        }
        return "▶ চলছে — \(model.status.url ?? "")"
    }

    private var screen: some View {
        GeometryReader { geo in
            let size = CGSize(width: geo.size.width,
                              height: geo.size.width * BrowserLiveModel.viewport.height / BrowserLiveModel.viewport.width)
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.35))
                if let frame = model.frame {
                    Image(uiImage: frame)
                        .resizable()
                        .interpolation(.medium)
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                } else {
                    Text(model.status.running ? "ছবি আসছে…" : "ব্রাউজার খুললে এখানে লাইভ দেখতে পাবেন")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
            .onTapGesture { location in
                model.tap(at: location, in: size)
                keyboardFocused = true
            }
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onEnded { value in model.scroll(by: -value.translation.height) }
            )
        }
        .aspectRatio(BrowserLiveModel.viewport.width / BrowserLiveModel.viewport.height, contentMode: .fit)
    }

    private var hint: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                // A hidden field is what gives the phone a keyboard at all; typing
                // into it forwards one character at a time, in order.
                TextField("টাইপ করতে এখানে লিখুন", text: $typed)
                    .focused($keyboardFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    // Single-parameter form: the deployment target is iOS 16, and
                    // the two-parameter onChange is 17+.
                    .onChange(of: typed) { newValue in
                        guard let last = newValue.last else { return }
                        model.type(String(last))
                        typed = ""
                    }
                    .onSubmit { model.press("Enter") }
                    .disabled(!model.status.running)

                Button("Enter") { model.press("Enter") }
                    .font(.caption.weight(.semibold))
                    .disabled(!model.status.running)

                Toggle("", isOn: $model.canTouch).labelsHidden()
            }
            Text("লগইন বা ক্যাপচা এলে নিজে পার করে দিন — বাকিটা এজেন্ট শেষ করবে।")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}
