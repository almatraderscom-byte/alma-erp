import Foundation
import XCTest
@testable import App

final class AgentCallStatusOutboxTests: XCTestCase {
    private let callA = "11111111-1111-4111-8111-111111111111"
    private let callB = "22222222-2222-4222-8222-222222222222"
    private let device = "ios-installation-a"
    private let receipt = Data(repeating: 7, count: 32).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")

    func testV2WireContractKeepsOnlyPrivacySafeDiagnosticCodes() async throws {
        let fixture = try Fixture()
        let note = try AlmaAgentCallDiagnosticNote("microphone_permission_denied")

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .failed,
            note: note))

        let pending = await fixture.outbox.pendingEvents()
        let request = try XCTUnwrap(pending.first)
        XCTAssertEqual(request.contractVersion, 2)
        XCTAssertEqual(request.deviceId, device)
        XCTAssertEqual(request.claimReceipt, receipt)
        XCTAssertEqual(request.status, .failed)
        XCTAssertEqual(request.note, "microphone_permission_denied")
        XCTAssertThrowsError(try AlmaAgentCallDiagnosticNote("boss@example.com"))
        XCTAssertThrowsError(try AlmaAgentCallDiagnosticNote("https://private.example/path"))
        XCTAssertThrowsError(try AlmaAgentCallDiagnosticNote(receipt))
    }

    func testOfflineAttemptSurvivesRecreationAndNetworkReplay() async throws {
        let store = MemoryStore()
        let clock = MutableClock(Date(timeIntervalSince1970: 1_000))
        let offline = ScriptedTransport([.failure])
        let ids = EventIds()
        let first = try AlmaAgentCallStatusOutbox(
            store: store,
            transport: offline,
            clock: clock,
            makeEventId: ids.next)

        let inserted = try await first.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered))
        let firstReport = try await first.replay(.manual)

        XCTAssertEqual(inserted, .init(disposition: .inserted, eventId: "event-1"))
        XCTAssertEqual(firstReport.attempted, 1)
        XCTAssertEqual(firstReport.retained, 1)

        let online = ScriptedTransport([.result(.ack(.answered))])
        let recreated = try AlmaAgentCallStatusOutbox(
            store: store,
            transport: online,
            clock: clock,
            makeEventId: ids.next)
        let replay = try await recreated.networkBecameReachable()

        XCTAssertEqual(replay.attempted, 1)
        XCTAssertEqual(replay.acknowledged, 1)
        XCTAssertEqual(replay.retained, 0)
        let sentStatuses = await online.statuses()
        XCTAssertEqual(sentStatuses, [.answered])
    }

    func testReorderedTerminalIsDeliveredOnlyAfterDurableAnswer() async throws {
        let transport = ScriptedTransport([
            .result(.ack(.answered)),
            .result(.ack(.completed)),
        ])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .completed,
            requiresAnswered: false))
        _ = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered))

        let report = try await fixture.outbox.replay(.manual)

        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.answered, .completed])
        XCTAssertEqual(report.acknowledged, 2)
        XCTAssertEqual(report.retained, 0)
    }

    func testStagedCallKitAnswerCannotReachHTTPBeforeRelease() async throws {
        let transport = ScriptedTransport([.result(.ack(.answered))])
        let fixture = try Fixture(transport: transport)

        let staged = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered,
            stageUntilReleased: true))
        let premature = try await fixture.outbox.networkBecameReachable()
        let statusesBeforeRelease = await transport.statuses()

        XCTAssertEqual(premature.attempted, 0)
        XCTAssertEqual(premature.retained, 1)
        XCTAssertEqual(statusesBeforeRelease, [])

        let answerReleased = try await fixture.outbox.releaseForReplay(
            eventId: try XCTUnwrap(staged.eventId))
        XCTAssertTrue(answerReleased)
        let released = try await fixture.outbox.replay(.manual)
        let statusesAfterRelease = await transport.statuses()

        XCTAssertEqual(released.acknowledged, 1)
        XCTAssertEqual(statusesAfterRelease, [.answered])
    }

    func testPreFulfillFailureAtomicallySupersedesStagedAnswer() async throws {
        let transport = ScriptedTransport([.result(.ack(.failed))])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered,
            stageUntilReleased: true))
        let failed = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .failed,
            requiresAnswered: false,
            stageUntilReleased: true))

        let pending = await fixture.outbox.pendingEvents()
        let statusesBeforeRelease = await transport.statuses()
        XCTAssertEqual(pending.map(\.status), [.failed])
        XCTAssertEqual(pending.map(\.eventId), ["event-2"])
        XCTAssertEqual(statusesBeforeRelease, [])

        let failureReleased = try await fixture.outbox.releaseForReplay(
            eventId: try XCTUnwrap(failed.eventId))
        XCTAssertTrue(failureReleased)
        _ = try await fixture.outbox.replay(.manual)
        let statusesAfterRelease = await transport.statuses()

        XCTAssertEqual(statusesAfterRelease, [.failed])
    }

    func testStagedIntentBecomesReplayableAfterProcessReconstruction() async throws {
        let store = MemoryStore()
        let clock = MutableClock(Date(timeIntervalSince1970: 1_000))
        let ids = EventIds()
        let first = try AlmaAgentCallStatusOutbox(
            store: store,
            transport: ScriptedTransport([]),
            clock: clock,
            makeEventId: ids.next)
        _ = try await first.enqueue(.init(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered,
            stageUntilReleased: true))

        let online = ScriptedTransport([.result(.ack(.answered))])
        let reconstructed = try AlmaAgentCallStatusOutbox(
            store: store,
            transport: online,
            clock: clock,
            makeEventId: ids.next)
        let replay = try await reconstructed.applicationDidBecomeActive()
        let statuses = await online.statuses()

        XCTAssertEqual(replay.acknowledged, 1)
        XCTAssertEqual(statuses, [.answered])
    }

    func testDuplicateEventKeepsStableIdAndIdempotentAckRemovesIt() async throws {
        let transport = ScriptedTransport([.result(.ack(.answered, idempotent: true))])
        let fixture = try Fixture(transport: transport)
        let input = AlmaAgentCallStatusOutbox.EnqueueInput(
            callId: callA,
            deviceId: device,
            claimReceipt: receipt,
            status: .answered)

        let first = try await fixture.outbox.enqueue(input)
        let duplicate = try await fixture.outbox.enqueue(input)
        let report = try await fixture.outbox.replay(.manual)

        XCTAssertEqual(first.eventId, "event-1")
        XCTAssertEqual(duplicate, .init(disposition: .duplicatePending, eventId: "event-1"))
        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.answered])
        XCTAssertEqual(report.acknowledged, 1)
        XCTAssertEqual(report.retained, 0)
    }

    func testConflictingTerminalNeverReplacesFirstTruth() async throws {
        let fixture = try Fixture()

        let completed = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            status: .completed))
        let failed = try await fixture.outbox.enqueue(.init(
            callId: callA,
            deviceId: device,
            status: .failed,
            requiresAnswered: true))

        XCTAssertEqual(completed.disposition, .inserted)
        XCTAssertEqual(failed, .init(disposition: .terminalConflict, eventId: nil))
        let pendingStatuses = await fixture.outbox.pendingEvents().map(\.status)
        XCTAssertEqual(pendingStatuses, [.completed])
    }

    func testNonRetryable409DropsAnswerAndDependentTerminal() async throws {
        let conflict = AlmaAgentCallStatusServerResponse(
            ok: false,
            changed: false,
            retryable: false,
            status: .answered,
            error: "device_mismatch")
        let transport = ScriptedTransport([.result(.init(statusCode: 409, response: conflict))])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .answered))
        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .completed))
        let report = try await fixture.outbox.replay(.manual)

        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.answered])
        XCTAssertEqual(report.dropped, 2)
        XCTAssertEqual(report.retained, 0)
    }

    func test426IsFinalAndNeverRetriedOnReplay() async throws {
        let sunset = AlmaAgentCallStatusServerResponse(
            ok: false,
            changed: false,
            retryable: false,
            error: "legacy_contract_sunset")
        let transport = ScriptedTransport([.result(.init(statusCode: 426, response: sunset))])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .declined))
        let first = try await fixture.outbox.replay(.manual)
        let second = try await fixture.outbox.networkBecameReachable()

        XCTAssertEqual(first.dropped, 1)
        XCTAssertEqual(second.attempted, 0)
        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.declined])
    }

    func testRetryable409And500RemainUntilSuccessfulReplay() async throws {
        let retryable = AlmaAgentCallStatusServerResponse(
            ok: false,
            changed: false,
            retryable: true,
            status: .ringing,
            error: "transition_raced")
        let transport = ScriptedTransport([
            .result(.init(statusCode: 409, response: retryable)),
            .result(.init(statusCode: 503, response: nil)),
            .result(.ack(.answered)),
        ])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .answered))
        let first = try await fixture.outbox.replay(.manual)
        let second = try await fixture.outbox.networkBecameReachable()
        let third = try await fixture.outbox.applicationDidBecomeActive()

        XCTAssertEqual(first.retained, 1)
        XCTAssertEqual(second.retained, 1)
        XCTAssertEqual(third.acknowledged, 1)
        XCTAssertEqual(third.retained, 0)
        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.answered, .answered, .answered])
    }

    func testRetryWakeAutomaticallyReplaysAtEarliestDeadline() async throws {
        var limits = AlmaAgentCallStatusOutbox.Limits()
        limits.initialRetryDelay = 5
        limits.maximumRetryDelay = 60
        let sleeper = ManualSleeper()
        let transport = ScriptedTransport([
            .result(.init(statusCode: 503, response: nil)),
            .result(.ack(.declined)),
        ])
        let fixture = try Fixture(
            transport: transport,
            limits: limits,
            sleeper: sleeper)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .declined))
        let first = try await fixture.outbox.replay(.manual)

        XCTAssertEqual(first.attempted, 1)
        XCTAssertEqual(first.retained, 1)
        await sleeper.waitForScheduleCount(1)
        let deadlines = await sleeper.scheduleHistory()
        XCTAssertEqual(deadlines, [fixture.clock.now.addingTimeInterval(5)])

        fixture.clock.advance(5)
        await sleeper.fireEarliest()
        await transport.waitForRequestCount(2)
        await waitForPendingCount(0, in: fixture.outbox)

        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.declined, .declined])
    }

    func testForcedReplayCancelsAndReschedulesRetryWake() async throws {
        var limits = AlmaAgentCallStatusOutbox.Limits()
        limits.initialRetryDelay = 5
        limits.maximumRetryDelay = 60
        let sleeper = ManualSleeper()
        let transport = ScriptedTransport([
            .result(.init(statusCode: 503, response: nil)),
            .result(.init(statusCode: 503, response: nil)),
            .result(.ack(.declined)),
        ])
        let fixture = try Fixture(
            transport: transport,
            limits: limits,
            sleeper: sleeper)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .declined))
        _ = try await fixture.outbox.replay(.manual)
        await sleeper.waitForScheduleCount(1)

        let forced = try await fixture.outbox.networkBecameReachable()
        XCTAssertEqual(forced.attempted, 1)
        XCTAssertEqual(forced.retained, 1)
        await sleeper.waitForCancellationCount(1)
        await sleeper.waitForScheduleCount(2)

        let deadlines = await sleeper.scheduleHistory()
        XCTAssertEqual(deadlines, [
            fixture.clock.now.addingTimeInterval(5),
            fixture.clock.now.addingTimeInterval(10),
        ])

        fixture.clock.advance(10)
        await sleeper.fireEarliest()
        await transport.waitForRequestCount(3)
        await waitForPendingCount(0, in: fixture.outbox)

        let sentStatuses = await transport.statuses()
        XCTAssertEqual(sentStatuses, [.declined, .declined, .declined])
    }

    func testMalformed2xxIsNotAcknowledgedWithoutRichReceipt() async throws {
        let malformed = AlmaAgentCallStatusServerResponse(ok: true, status: .answered)
        let transport = ScriptedTransport([
            .result(.init(statusCode: 200, response: malformed)),
            .result(.ack(.answered)),
        ])
        let fixture = try Fixture(transport: transport)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .answered))
        let first = try await fixture.outbox.replay(.manual)
        let second = try await fixture.outbox.networkBecameReachable()

        XCTAssertEqual(first.retained, 1)
        XCTAssertEqual(second.acknowledged, 1)
        XCTAssertEqual(second.retained, 0)
    }

    func testConcurrentReplayUsesOneSerialTransportDrain() async throws {
        let transport = GateTransport()
        let fixture = try Fixture(transport: transport)
        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .declined))

        async let first = fixture.outbox.replay(.manual)
        await transport.waitUntilCalled()
        let overlapping = try await fixture.outbox.replay(.networkBecameReachable)
        await transport.release(.ack(.declined))
        let completed = try await first

        XCTAssertTrue(overlapping.alreadyDraining)
        XCTAssertEqual(completed.acknowledged, 1)
        let callCount = await transport.callCount()
        XCTAssertEqual(callCount, 1)
    }

    func testBoundsEvictWholeOldestCallWithoutOrphaningItsTerminal() async throws {
        var limits = AlmaAgentCallStatusOutbox.Limits()
        limits.maximumCalls = 1
        limits.maximumEvents = 2
        let fixture = try Fixture(limits: limits)

        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .answered))
        _ = try await fixture.outbox.enqueue(.init(
            callId: callA, deviceId: device, status: .completed))
        _ = try await fixture.outbox.enqueue(.init(
            callId: callB, deviceId: device, status: .declined))

        let pending = await fixture.outbox.pendingEvents()
        XCTAssertEqual(pending.map(\.status), [.declined])
        XCTAssertEqual(pending.map(\.eventId), ["event-3"])
    }

    private func waitForPendingCount(
        _ expected: Int,
        in outbox: AlmaAgentCallStatusOutbox,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<2_000 {
            if await outbox.pendingEvents().count == expected { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for \(expected) pending outbox events", file: file, line: line)
    }
}

// MARK: - Deterministic collaborators

private final class MemoryStore: AlmaAgentCallStatusOutboxStore {
    private var data: Data?
    func load() throws -> Data? { data }
    func save(_ data: Data) throws { self.data = data }
}

private final class MutableClock: AlmaAgentCallStatusClock {
    var now: Date
    init(_ now: Date) { self.now = now }
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

private final class EventIds {
    private var value = 0
    func next() -> String {
        value += 1
        return "event-\(value)"
    }
}

private enum TransportFailure: Error { case offline }

private actor ScriptedTransport: AlmaAgentCallStatusTransport {
    enum Step {
        case result(AlmaAgentCallStatusHTTPResult)
        case failure
    }

    private var steps: [Step]
    private var requests: [AlmaAgentCallStatusRequest] = []
    private var requestWaiters: [(
        expected: Int,
        continuation: CheckedContinuation<Void, Never>
    )] = []

    init(_ steps: [Step]) { self.steps = steps }

    func send(
        callId: String,
        request: AlmaAgentCallStatusRequest
    ) async throws -> AlmaAgentCallStatusHTTPResult {
        requests.append(request)
        let ready = requestWaiters.filter { requests.count >= $0.expected }
        requestWaiters.removeAll { requests.count >= $0.expected }
        ready.forEach { $0.continuation.resume() }
        guard !steps.isEmpty else { throw TransportFailure.offline }
        switch steps.removeFirst() {
        case .result(let result): return result
        case .failure: throw TransportFailure.offline
        }
    }

    func statuses() -> [AlmaAgentCallStatus] { requests.map(\.status) }

    func waitForRequestCount(_ expected: Int) async {
        if requests.count >= expected { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append((expected, continuation))
        }
    }
}

private actor ManualSleeper: AlmaAgentCallStatusSleeper {
    private struct Entry {
        let deadline: Date
        let continuation: CheckedContinuation<Void, Never>
    }

    private var entries: [UUID: Entry] = [:]
    private var history: [Date] = []
    private var cancellations = 0
    private var scheduleWaiters: [(
        expected: Int,
        continuation: CheckedContinuation<Void, Never>
    )] = []
    private var cancellationWaiters: [(
        expected: Int,
        continuation: CheckedContinuation<Void, Never>
    )] = []

    func sleep(until deadline: Date) async {
        if Task.isCancelled { return }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                entries[id] = Entry(deadline: deadline, continuation: continuation)
                history.append(deadline)
                let ready = scheduleWaiters.filter { history.count >= $0.expected }
                scheduleWaiters.removeAll { history.count >= $0.expected }
                ready.forEach { $0.continuation.resume() }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        cancellations += 1
        entry.continuation.resume()
        let ready = cancellationWaiters.filter { cancellations >= $0.expected }
        cancellationWaiters.removeAll { cancellations >= $0.expected }
        ready.forEach { $0.continuation.resume() }
    }

    func fireEarliest() {
        guard let candidate = entries.min(by: {
            $0.value.deadline < $1.value.deadline
        }) else { return }
        entries.removeValue(forKey: candidate.key)?.continuation.resume()
    }

    func scheduleHistory() -> [Date] { history }

    func waitForScheduleCount(_ expected: Int) async {
        if history.count >= expected { return }
        await withCheckedContinuation { continuation in
            scheduleWaiters.append((expected, continuation))
        }
    }

    func waitForCancellationCount(_ expected: Int) async {
        if cancellations >= expected { return }
        await withCheckedContinuation { continuation in
            cancellationWaiters.append((expected, continuation))
        }
    }
}

private actor GateTransport: AlmaAgentCallStatusTransport {
    private var calls = 0
    private var continuation: CheckedContinuation<AlmaAgentCallStatusHTTPResult, Error>?

    func send(
        callId: String,
        request: AlmaAgentCallStatusRequest
    ) async throws -> AlmaAgentCallStatusHTTPResult {
        calls += 1
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }

    func waitUntilCalled() async {
        while calls == 0 { await Task.yield() }
    }

    func release(_ result: AlmaAgentCallStatusHTTPResult) {
        continuation?.resume(returning: result)
        continuation = nil
    }

    func callCount() -> Int { calls }
}

private struct Fixture {
    let store: MemoryStore
    let clock: MutableClock
    let transport: AlmaAgentCallStatusTransport
    let ids: EventIds
    let outbox: AlmaAgentCallStatusOutbox

    init(
        transport: AlmaAgentCallStatusTransport? = nil,
        limits: AlmaAgentCallStatusOutbox.Limits = .init(),
        sleeper: AlmaAgentCallStatusSleeper = AlmaAgentCallStatusSystemSleeper()
    ) throws {
        store = MemoryStore()
        clock = MutableClock(Date(timeIntervalSince1970: 1_000))
        self.transport = transport ?? ScriptedTransport([])
        ids = EventIds()
        outbox = try AlmaAgentCallStatusOutbox(
            store: store,
            transport: self.transport,
            clock: clock,
            sleeper: sleeper,
            limits: limits,
            makeEventId: ids.next)
    }
}

private extension AlmaAgentCallStatusHTTPResult {
    static func ack(
        _ status: AlmaAgentCallStatus,
        idempotent: Bool = false,
        superseded: Bool = false
    ) -> Self {
        .init(
            statusCode: 200,
            response: .init(
                ok: true,
                changed: !idempotent && !superseded,
                idempotent: idempotent,
                superseded: superseded,
                retryable: false,
                status: AlmaAgentCallCanonicalStatus(rawValue: status.rawValue)))
    }
}
