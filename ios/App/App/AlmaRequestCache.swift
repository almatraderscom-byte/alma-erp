//
//  AlmaRequestCache.swift
//  ALMA ERP — IOSP-3: request single-flight + conservative TTL cache.
//
//  Two independent jobs, both keyed on method+path+sorted-query so only truly
//  identical GETs share anything:
//
//    1. Single-flight (always on for GET) — N concurrent identical GETs collapse
//       to ONE wire round-trip; every caller awaits the same Task. Pure win, no
//       semantic change: everyone gets the same bytes they'd have fetched anyway.
//       The IOSP-0 baseline showed screens firing duplicate loads on appearance;
//       this coalesces them.
//
//    2. TTL cache (OPT-IN via AlmaAPI.getCached) — a per-resource freshness
//       window. Warm re-navigation to a read-only screen within the window
//       returns the cached bytes with zero refetch. Callers choose the TTL; the
//       default get() never caches, so nothing is cached unless a screen asks.
//
//  Safety rails (roadmap §12): ANY mutation (POST/PATCH/DELETE) clears the whole
//  TTL cache, so a write's effects can never be masked by a stale read. Approval
//  decisions and money mutations are writes → they always invalidate. Nothing is
//  cached to disk; this is process-lifetime memory only.
//

import Foundation

actor AlmaRequestCache {
    static let shared = AlmaRequestCache()

    /// Cache key: only GETs are ever keyed; query is order-normalised.
    static func key(method: String, path: String, query: [String: String?]) -> String {
        let q = query
            .compactMap { k, v in v.map { "\(k)=\($0)" } }
            .sorted()
            .joined(separator: "&")
        return "\(method) \(path)?\(q)"
    }

    private struct Entry {
        let data: Data
        let stored: Date
    }

    private var inFlight: [String: Task<Data, Error>] = [:]
    private var store: [String: Entry] = [:]

    /// Coalesce concurrent identical GETs. If a matching request is already in
    /// flight, await it; otherwise run `fetch`, share it, and clear on completion.
    func singleFlight(key: String, fetch: @Sendable @escaping () async throws -> Data) async throws -> Data {
        if let existing = inFlight[key] {
            return try await existing.value
        }
        let task = Task { try await fetch() }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        return try await task.value
    }

    /// TTL read: return cached bytes if within `ttl`, else fetch (single-flighted),
    /// store, and return. `ttl <= 0` bypasses the cache but still single-flights.
    func cached(key: String, ttl: TimeInterval,
                fetch: @Sendable @escaping () async throws -> Data) async throws -> Data {
        if ttl > 0, let e = store[key], Date().timeIntervalSince(e.stored) < ttl {
            AlmaPerfLog.event("cache.hit", key)
            return e.data
        }
        let data = try await singleFlight(key: key, fetch: fetch)
        if ttl > 0 { store[key] = Entry(data: data, stored: Date()) }
        return data
    }

    /// Drop every cached read. Called after any mutation so writes are never
    /// masked by a stale GET. Coarse on purpose — correctness over cleverness.
    func invalidateAll() {
        if !store.isEmpty { AlmaPerfLog.event("cache.invalidateAll", "\(store.count)") }
        store.removeAll()
    }

    /// Drop cached reads whose key contains `pathFragment` (targeted invalidation).
    func invalidate(matching pathFragment: String) {
        store = store.filter { !$0.key.contains(pathFragment) }
    }
}
