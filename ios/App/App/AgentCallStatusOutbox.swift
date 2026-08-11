import Foundation

// MARK: - Wire contract

enum AlmaAgentCallStatus: String, Codable, CaseIterable {
    case answered
    case declined
    case completed
    case failed

    var isTerminal: Bool { self != .answered }
}

enum AlmaAgentCallCanonicalStatus: String, Codable, CaseIterable {
    case ringing
    case answered
    case completed
    case declined
    case unanswered
    case failed

    var isTerminal: Bool { self != .ringing && self != .answered }
}

/// Deliberately a code, not free-form text. Restricting this at the boundary
/// keeps transcripts, URLs, email addresses, bearer receipts, and user content
/// out of the durable diagnostics queue.
struct AlmaAgentCallDiagnosticNote: Codable, Equatable {
    let code: String

    init(_ code: String) throws {
        guard code.range(
            of: #"^[a-z0-9][a-z0-9._:-]{0,119}$"#,
            options: .regularExpression
        ) != nil else {
            throw AlmaAgentCallStatusOutboxError.invalidDiagnosticCode
        }
        self.code = code
    }
}

struct AlmaAgentCallStatusRequest: Codable, Equatable {
    let eventId: String
    let contractVersion: Int
    let deviceId: String
    let claimReceipt: String?
    let status: AlmaAgentCallStatus
    let note: String?

    init(
        eventId: String,
        deviceId: String,
        claimReceipt: String?,
        status: AlmaAgentCallStatus,
        note: String?
    ) {
        self.eventId = eventId
        contractVersion = 2
        self.deviceId = deviceId
        self.claimReceipt = claimReceipt
        self.status = status
        self.note = note
    }
}

struct AlmaAgentCallStatusServerResponse: Codable, Equatable {
    let ok: Bool
    let changed: Bool?
    let idempotent: Bool?
    let superseded: Bool?
    let retryable: Bool?
    let status: AlmaAgentCallCanonicalStatus?
    let error: String?

    init(
        ok: Bool,
        changed: Bool? = nil,
        idempotent: Bool? = nil,
        superseded: Bool? = nil,
        retryable: Bool? = nil,
        status: AlmaAgentCallCanonicalStatus? = nil,
        error: String? = nil
    ) {
        self.ok = ok
        self.changed = changed
        self.idempotent = idempotent
        self.superseded = superseded
        self.retryable = retryable
        self.status = status
        self.error = error
    }

    fileprivate func acknowledges(_ sentStatus: AlmaAgentCallStatus) -> Bool {
        guard ok, let status else { return false }
        let hasReceipt = changed == true || idempotent == true || superseded == true
        guard hasReceipt else { return false }
        return status.rawValue == sentStatus.rawValue
            || (sentStatus == .answered && superseded == true)
    }
}

struct AlmaAgentCallStatusHTTPResult: Equatable {
    let statusCode: Int
    let response: AlmaAgentCallStatusServerResponse?
}

protocol AlmaAgentCallStatusTransport: AnyObject {
    func send(
        callId: String,
        request: AlmaAgentCallStatusRequest
    ) async throws -> AlmaAgentCallStatusHTTPResult
}

// MARK: - Persistence and time

protocol AlmaAgentCallStatusOutboxStore: AnyObject {
    func load() throws -> Data?
    func save(_ data: Data) throws
}

final class AlmaAgentCallStatusUserDefaultsStore: AlmaAgentCallStatusOutboxStore {
    static let defaultKey = "alma.agent-call.status-outbox.v2"

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    func load() throws -> Data? { defaults.data(forKey: key) }

    func save(_ data: Data) throws { defaults.set(data, forKey: key) }
}

protocol AlmaAgentCallStatusClock: AnyObject {
    var now: Date { get }
}

final class AlmaAgentCallStatusSystemClock: AlmaAgentCallStatusClock {
    var now: Date { Date() }
}

/// Isolated so retry timing is deterministic in tests and cancellation never
/// depends on a real wall-clock sleep. Production uses one cancellable Task per
/// earliest pending retry deadline.
protocol AlmaAgentCallStatusSleeper: Sendable {
    func sleep(until deadline: Date) async
}

struct AlmaAgentCallStatusSystemSleeper: AlmaAgentCallStatusSleeper {
    func sleep(until deadline: Date) async {
        let seconds = max(0, deadline.timeIntervalSinceNow)
        let capped = min(seconds, Double(UInt64.max) / 1_000_000_000)
        try? await Task.sleep(nanoseconds: UInt64(capped * 1_000_000_000))
    }
}

enum AlmaAgentCallStatusOutboxError: Error, Equatable {
    case corruptStore
    case unsupportedStoreVersion
    case invalidCallId
    case invalidDeviceId
    case invalidClaimReceipt
    case invalidDiagnosticCode
    case deviceChangedForCall
    case claimReceiptChangedForCall
}

// MARK: - Durable outbox

actor AlmaAgentCallStatusOutbox {
    struct Limits: Equatable {
        var maximumCalls = 32
        var maximumEvents = 64
        var eventRetention: TimeInterval = 48 * 60 * 60
        var recordRetention: TimeInterval = 7 * 24 * 60 * 60
        var initialRetryDelay: TimeInterval = 2
        var maximumRetryDelay: TimeInterval = 5 * 60
    }

    struct EnqueueInput: Equatable {
        let callId: String
        let deviceId: String
        let claimReceipt: String?
        let status: AlmaAgentCallStatus
        let note: AlmaAgentCallDiagnosticNote?
        /// `failed` is valid both before and after answer. CallKit must set this
        /// when CXAnswer was fulfilled so the durable answer is sent first.
        let requiresAnswered: Bool
        /// CallKit persists lifecycle intent before completing the corresponding
        /// OS action. A staged event is durable but cannot join any concurrent
        /// HTTP drain until that action has completed and explicitly releases it.
        let stageUntilReleased: Bool

        init(
            callId: String,
            deviceId: String,
            claimReceipt: String? = nil,
            status: AlmaAgentCallStatus,
            note: AlmaAgentCallDiagnosticNote? = nil,
            requiresAnswered: Bool? = nil,
            stageUntilReleased: Bool = false
        ) {
            self.callId = callId
            self.deviceId = deviceId
            self.claimReceipt = claimReceipt
            self.status = status
            self.note = note
            // A v2 completed transition is never valid directly from ringing.
            // Keep this invariant inside the queue even if an integration
            // accidentally supplies `false`; `failed` remains context-sensitive.
            self.requiresAnswered = status == .completed
                || (status == .failed && requiresAnswered == true)
            self.stageUntilReleased = stageUntilReleased
        }
    }

    enum EnqueueDisposition: String, Equatable {
        case inserted
        case duplicatePending
        case alreadyFinalized
        case superseded
        case terminalConflict
    }

    struct EnqueueResult: Equatable {
        let disposition: EnqueueDisposition
        let eventId: String?
    }

    enum ReplayTrigger: String, Equatable {
        case manual
        case applicationDidBecomeActive
        case networkBecameReachable

        fileprivate var forcesRetry: Bool { self != .manual }
    }

    struct DrainReport: Equatable {
        var attempted = 0
        var acknowledged = 0
        var dropped = 0
        var retained = 0
        var alreadyDraining = false
    }

    private struct Event: Codable, Equatable {
        let eventId: String
        let callId: String
        let deviceId: String
        var claimReceipt: String?
        let status: AlmaAgentCallStatus
        let note: String?
        let requiresAnswered: Bool
        let sequence: Int64
        let createdAt: Date
        var attempts: Int
        var nextAttemptAt: Date
        /// Optional preserves decoding of v1 snapshots written before staged
        /// delivery existed. `nil` is therefore an already-released event.
        var deliveryReady: Bool?

        var isDeliveryReady: Bool { deliveryReady != false }

        var request: AlmaAgentCallStatusRequest {
            AlmaAgentCallStatusRequest(
                eventId: eventId,
                deviceId: deviceId,
                claimReceipt: claimReceipt,
                status: status,
                note: note)
        }
    }

    private struct CallRecord: Codable, Equatable {
        let callId: String
        let deviceId: String
        var claimReceipt: String?
        var answerAcknowledged = false
        var answerFinalized = false
        var terminalStatus: AlmaAgentCallCanonicalStatus?
        var terminalFinalized = false
        var updatedAt: Date
    }

    private struct Snapshot: Codable, Equatable {
        var version = 1
        var nextSequence: Int64 = 1
        var events: [Event] = []
        var calls: [String: CallRecord] = [:]
    }

    private enum DeliveryDecision {
        case acknowledge(AlmaAgentCallStatusServerResponse)
        case retry
        case drop(AlmaAgentCallStatusServerResponse?)
    }

    private let store: AlmaAgentCallStatusOutboxStore
    private let transport: AlmaAgentCallStatusTransport
    private let clock: AlmaAgentCallStatusClock
    private let sleeper: AlmaAgentCallStatusSleeper
    private let limits: Limits
    private let makeEventId: () -> String
    private let encoder: JSONEncoder
    private var snapshot: Snapshot
    private var isDraining = false
    private var replayRequested = false
    private var forcedReplayRequested = false
    private var retryWakeTask: Task<Void, Never>?
    private var retryWakeDeadline: Date?
    private var retryWakeGeneration: UInt64 = 0

    init(
        store: AlmaAgentCallStatusOutboxStore = AlmaAgentCallStatusUserDefaultsStore(),
        transport: AlmaAgentCallStatusTransport,
        clock: AlmaAgentCallStatusClock = AlmaAgentCallStatusSystemClock(),
        sleeper: AlmaAgentCallStatusSleeper = AlmaAgentCallStatusSystemSleeper(),
        limits: Limits = Limits(),
        makeEventId: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) throws {
        self.store = store
        self.transport = transport
        self.clock = clock
        self.sleeper = sleeper
        self.limits = limits
        self.makeEventId = makeEventId
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        self.encoder = encoder

        if let data = try store.load() {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            guard let decoded = try? decoder.decode(Snapshot.self, from: data) else {
                throw AlmaAgentCallStatusOutboxError.corruptStore
            }
            guard decoded.version == 1 else {
                throw AlmaAgentCallStatusOutboxError.unsupportedStoreVersion
            }
            snapshot = decoded
        } else {
            snapshot = Snapshot()
        }
        Self.normalize(&snapshot, now: clock.now, limits: limits)
        // A staged event can straddle a process death immediately after CallKit
        // completed but before the follow-up promotion write. Recover it as ready
        // on reconstruction: the durable intent is the crash-safety boundary.
        for index in snapshot.events.indices
        where snapshot.events[index].deliveryReady == false {
            snapshot.events[index].deliveryReady = true
        }
        try store.save(encoder.encode(snapshot))
    }

    @discardableResult
    func enqueue(_ input: EnqueueInput) throws -> EnqueueResult {
        defer { rescheduleRetryWake() }
        let now = clock.now
        Self.normalize(&snapshot, now: now, limits: limits)
        let callId = try Self.normalizedCallId(input.callId)
        let deviceId = try Self.normalizedDeviceId(input.deviceId)
        let receipt = try Self.normalizedReceipt(input.claimReceipt)

        var record = snapshot.calls[callId] ?? CallRecord(
            callId: callId,
            deviceId: deviceId,
            claimReceipt: receipt,
            updatedAt: now)
        guard record.deviceId == deviceId else {
            throw AlmaAgentCallStatusOutboxError.deviceChangedForCall
        }
        if let existingReceipt = record.claimReceipt, let receipt,
           existingReceipt != receipt {
            throw AlmaAgentCallStatusOutboxError.claimReceiptChangedForCall
        }
        if record.claimReceipt == nil { record.claimReceipt = receipt }
        record.updatedAt = now

        // A pre-answer terminal transition proves a staged answer never reached
        // CallKit completion. Replace that exact local intent atomically before
        // it can ever become HTTP-eligible.
        if input.status.isTerminal, !input.requiresAnswered {
            snapshot.events.removeAll {
                $0.callId == callId
                    && $0.status == .answered
                    && !$0.isDeliveryReady
            }
        }

        if input.status == .answered {
            if record.terminalFinalized {
                snapshot.calls[callId] = record
                try persist()
                return EnqueueResult(disposition: .superseded, eventId: nil)
            }
            if record.answerFinalized {
                snapshot.calls[callId] = record
                try persist()
                return EnqueueResult(disposition: .alreadyFinalized, eventId: nil)
            }
            if let existing = snapshot.events.first(where: {
                $0.callId == callId && $0.status == .answered
            }) {
                if input.stageUntilReleased,
                   let index = snapshot.events.firstIndex(where: {
                       $0.eventId == existing.eventId
                   }) {
                    snapshot.events[index].deliveryReady = false
                }
                snapshot.calls[callId] = record
                try persist()
                return EnqueueResult(disposition: .duplicatePending, eventId: existing.eventId)
            }
        } else {
            if record.terminalFinalized {
                let disposition: EnqueueDisposition = record.terminalStatus?.rawValue == input.status.rawValue
                    ? .alreadyFinalized : .terminalConflict
                snapshot.calls[callId] = record
                try persist()
                return EnqueueResult(disposition: disposition, eventId: nil)
            }
            if let existing = snapshot.events.first(where: {
                $0.callId == callId && $0.status.isTerminal
            }) {
                if input.stageUntilReleased,
                   let index = snapshot.events.firstIndex(where: {
                       $0.eventId == existing.eventId
                   }) {
                    snapshot.events[index].deliveryReady = false
                }
                snapshot.calls[callId] = record
                try persist()
                return EnqueueResult(
                    disposition: existing.status == input.status
                        ? .duplicatePending : .terminalConflict,
                    eventId: existing.status == input.status ? existing.eventId : nil)
            }
        }

        let eventId = makeEventId()
        let event = Event(
            eventId: eventId,
            callId: callId,
            deviceId: deviceId,
            claimReceipt: receipt ?? record.claimReceipt,
            status: input.status,
            note: input.note?.code,
            requiresAnswered: input.status == .answered ? false : input.requiresAnswered,
            sequence: snapshot.nextSequence,
            createdAt: now,
            attempts: 0,
            nextAttemptAt: now,
            deliveryReady: input.stageUntilReleased ? false : true)
        snapshot.nextSequence += 1
        snapshot.events.append(event)
        snapshot.calls[callId] = record
        Self.enforceBounds(&snapshot, limits: limits)
        replayRequested = true
        try persist()
        return EnqueueResult(disposition: .inserted, eventId: eventId)
    }

    func pendingEvents() -> [AlmaAgentCallStatusRequest] {
        snapshot.events.sorted { $0.sequence < $1.sequence }.map(\.request)
    }

    /// Promotes one already-durable CallKit event after its OS completion. The
    /// caller remains responsible for starting replay after this bounded write.
    @discardableResult
    func releaseForReplay(eventId: String) throws -> Bool {
        guard let index = snapshot.events.firstIndex(where: {
            $0.eventId == eventId && !$0.isDeliveryReady
        }) else { return false }
        snapshot.events[index].deliveryReady = true
        try persist()
        rescheduleRetryWake()
        return true
    }

    func replay(_ trigger: ReplayTrigger) async throws -> DrainReport {
        if isDraining {
            replayRequested = true
            forcedReplayRequested = forcedReplayRequested || trigger.forcesRetry
            return DrainReport(
                retained: snapshot.events.count,
                alreadyDraining: true)
        }

        isDraining = true
        cancelRetryWake()
        defer {
            isDraining = false
            rescheduleRetryWake()
        }
        var report = DrainReport()
        var force = trigger.forcesRetry
        var blockedCalls = Set<String>()

        while true {
            replayRequested = false
            forcedReplayRequested = false
            Self.normalize(&snapshot, now: clock.now, limits: limits)
            try persist()

            while let event = nextDeliverable(
                now: clock.now,
                force: force,
                blockedCalls: blockedCalls
            ) {
                report.attempted += 1
                let decision: DeliveryDecision
                do {
                    let result = try await transport.send(
                        callId: event.callId,
                        request: event.request)
                    decision = Self.classify(result, sentStatus: event.status)
                } catch {
                    decision = .retry
                }

                switch decision {
                case .acknowledge(let response):
                    acknowledge(event, response: response, now: clock.now)
                    report.acknowledged += 1
                case .retry:
                    retry(event, now: clock.now)
                    blockedCalls.insert(event.callId)
                case .drop(let response):
                    report.dropped += drop(event, response: response, now: clock.now)
                }
                try persist()
                rescheduleRetryWake()
            }

            if replayRequested {
                force = force || forcedReplayRequested
                blockedCalls.removeAll()
                continue
            }
            break
        }

        report.retained = snapshot.events.count
        return report
    }

    func applicationDidBecomeActive() async throws -> DrainReport {
        try await replay(.applicationDidBecomeActive)
    }

    func networkBecameReachable() async throws -> DrainReport {
        try await replay(.networkBecameReachable)
    }

    // MARK: Delivery state machine

    private func nextDeliverable(
        now: Date,
        force: Bool,
        blockedCalls: Set<String>
    ) -> Event? {
        var heads: [Event] = []
        for (callId, events) in Dictionary(grouping: snapshot.events, by: \Event.callId) {
            guard !blockedCalls.contains(callId) else { continue }
            let record = snapshot.calls[callId]
            let answered = events
                .filter { $0.status == .answered && $0.isDeliveryReady }
                .min { $0.sequence < $1.sequence }
            let head: Event?
            if let answered {
                head = answered
            } else {
                head = events
                    .filter {
                        $0.isDeliveryReady
                            && (!$0.requiresAnswered || record?.answerAcknowledged == true)
                    }
                    .min { $0.sequence < $1.sequence }
            }
            if let head, force || head.nextAttemptAt <= now { heads.append(head) }
        }
        return heads.min { $0.sequence < $1.sequence }
    }

    private static func classify(
        _ result: AlmaAgentCallStatusHTTPResult,
        sentStatus: AlmaAgentCallStatus
    ) -> DeliveryDecision {
        if result.statusCode >= 500 { return .retry }
        if result.response?.retryable == true { return .retry }
        if (200..<300).contains(result.statusCode) {
            guard let response = result.response,
                  response.acknowledges(sentStatus) else { return .retry }
            return .acknowledge(response)
        }
        return .drop(result.response)
    }

    private func acknowledge(
        _ event: Event,
        response: AlmaAgentCallStatusServerResponse,
        now: Date
    ) {
        remove(event.eventId)
        guard var record = snapshot.calls[event.callId] else { return }
        record.updatedAt = now
        if event.status == .answered {
            record.answerAcknowledged = true
            record.answerFinalized = true
            record.claimReceipt = nil
            for index in snapshot.events.indices where snapshot.events[index].callId == event.callId {
                snapshot.events[index].claimReceipt = nil
            }
            if response.superseded == true, let canonical = response.status,
               canonical.isTerminal {
                record.terminalStatus = canonical
                record.terminalFinalized = true
                snapshot.events.removeAll { $0.callId == event.callId }
            }
        } else {
                record.terminalStatus = response.status
                    ?? AlmaAgentCallCanonicalStatus(rawValue: event.status.rawValue)
            record.terminalFinalized = true
            record.claimReceipt = nil
            snapshot.events.removeAll { $0.callId == event.callId }
        }
        snapshot.calls[event.callId] = record
    }

    private func retry(_ event: Event, now: Date) {
        guard let index = snapshot.events.firstIndex(where: { $0.eventId == event.eventId }) else {
            return
        }
        snapshot.events[index].attempts += 1
        let exponent = min(snapshot.events[index].attempts - 1, 12)
        let delay = min(
            limits.maximumRetryDelay,
            limits.initialRetryDelay * pow(2, Double(exponent)))
        snapshot.events[index].nextAttemptAt = now.addingTimeInterval(delay)
    }

    @discardableResult
    private func drop(
        _ event: Event,
        response: AlmaAgentCallStatusServerResponse?,
        now: Date
    ) -> Int {
        remove(event.eventId)
        guard var record = snapshot.calls[event.callId] else { return 1 }
        record.updatedAt = now
        var dropped = 1
        if event.status == .answered {
            record.answerFinalized = true
            record.claimReceipt = nil
            if let canonical = response?.status, canonical.isTerminal {
                record.terminalStatus = canonical
                record.terminalFinalized = true
                dropped += snapshot.events.filter { $0.callId == event.callId }.count
                snapshot.events.removeAll { $0.callId == event.callId }
            } else {
                let dependent = snapshot.events.filter {
                    $0.callId == event.callId && $0.requiresAnswered
                }.count
                dropped += dependent
                snapshot.events.removeAll {
                    $0.callId == event.callId && $0.requiresAnswered
                }
            }
        } else {
            record.terminalStatus = response?.status?.isTerminal == true
                ? response?.status
                : AlmaAgentCallCanonicalStatus(rawValue: event.status.rawValue)
            record.terminalFinalized = true
            record.claimReceipt = nil
            dropped += snapshot.events.filter { $0.callId == event.callId }.count
            snapshot.events.removeAll { $0.callId == event.callId }
        }
        snapshot.calls[event.callId] = record
        return dropped
    }

    private func remove(_ eventId: String) {
        snapshot.events.removeAll { $0.eventId == eventId }
    }

    // MARK: Retry wake-up

    private func cancelRetryWake() {
        retryWakeGeneration &+= 1
        retryWakeTask?.cancel()
        retryWakeTask = nil
        retryWakeDeadline = nil
    }

    /// Initial events are drained explicitly by the integration after its local
    /// CallKit completion. Only events that have actually failed transport/server
    /// delivery receive an automatic wake-up, so enqueue itself can never put
    /// network work on a CallKit deadline.
    private func rescheduleRetryWake() {
        guard !isDraining else { return }
        let earliest = snapshot.events
            .filter { $0.attempts > 0 && $0.isDeliveryReady }
            .map(\.nextAttemptAt)
            .min()

        guard let earliest else {
            if retryWakeTask != nil { cancelRetryWake() }
            return
        }
        if retryWakeTask != nil, retryWakeDeadline == earliest { return }

        cancelRetryWake()
        retryWakeGeneration &+= 1
        let generation = retryWakeGeneration
        retryWakeDeadline = earliest
        let sleeper = sleeper
        retryWakeTask = Task { [weak self] in
            await sleeper.sleep(until: earliest)
            guard !Task.isCancelled else { return }
            await self?.retryWakeFired(generation: generation, deadline: earliest)
        }
    }

    private func retryWakeFired(generation: UInt64, deadline: Date) async {
        guard retryWakeGeneration == generation,
              retryWakeDeadline == deadline
        else { return }
        retryWakeTask = nil
        retryWakeDeadline = nil
        _ = try? await replay(.manual)
    }

    // MARK: Validation, retention, encoding

    private static func normalizedCallId(_ raw: String) throws -> String {
        guard let uuid = UUID(uuidString: raw) else {
            throw AlmaAgentCallStatusOutboxError.invalidCallId
        }
        return uuid.uuidString.lowercased()
    }

    private static func normalizedDeviceId(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 180,
              value.range(
                of: #"^[A-Za-z0-9._:-]+$"#,
                options: .regularExpression) != nil else {
            throw AlmaAgentCallStatusOutboxError.invalidDeviceId
        }
        return value
    }

    private static func normalizedReceipt(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(
            of: #"^[A-Za-z0-9_-]{43}$"#,
            options: .regularExpression) != nil else {
            throw AlmaAgentCallStatusOutboxError.invalidClaimReceipt
        }
        return value
    }

    private static func normalize(_ value: inout Snapshot, now: Date, limits: Limits) {
        let eventCutoff = now.addingTimeInterval(-limits.eventRetention)
        value.events.removeAll { $0.createdAt < eventCutoff }
        let maxSequence = value.events.map(\.sequence).max() ?? 0
        value.nextSequence = max(value.nextSequence, maxSequence + 1)
        let pendingCalls = Set(value.events.map(\.callId))
        let recordCutoff = now.addingTimeInterval(-limits.recordRetention)
        value.calls = value.calls.filter { callId, record in
            pendingCalls.contains(callId) || record.updatedAt >= recordCutoff
        }
        enforceBounds(&value, limits: limits)
    }

    private static func enforceBounds(_ value: inout Snapshot, limits: Limits) {
        while Set(value.events.map(\.callId)).count > limits.maximumCalls
                || value.events.count > limits.maximumEvents {
            guard let oldestCall = Dictionary(grouping: value.events, by: \Event.callId)
                .min(by: { lhs, rhs in
                    (lhs.value.map(\.sequence).min() ?? .max)
                        < (rhs.value.map(\.sequence).min() ?? .max)
                })?.key else { break }
            value.events.removeAll { $0.callId == oldestCall }
            value.calls.removeValue(forKey: oldestCall)
        }
    }

    private func persist() throws {
        try store.save(encoder.encode(snapshot))
    }
}
