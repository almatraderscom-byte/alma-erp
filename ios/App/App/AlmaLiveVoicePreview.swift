import AVFoundation
import CryptoKit
import Foundation
import UIKit

enum AlmaLiveVoicePreviewError: Error, Equatable {
    case malformedCatalog(String)
    case catalogResourceMissing
    case entryNotFound(modelID: String, voiceID: String)
    case unsafePath(String)
    case assetMissing(String)
    case integrityMismatch(String)
    case invalidCDN(String)
    case networkRejected(String)
    case audioPlaybackFailed
}

struct AlmaLiveVoicePreviewCatalog: Decodable, Equatable, Sendable {
    enum Status: String, Decodable, Sendable {
        case generatedPendingOwnerApproval = "generated_pending_owner_approval"
        case ownerApprovedReleaseReady = "owner_approved_release_ready"
    }

    struct Cache: Decodable, Equatable, Sendable {
        let immutable: Bool
        let memory: Bool
        let diskLimitBytes: Int
        let revalidateAfterSeconds: Int
        let checksum: String
    }

    struct Entry: Decodable, Equatable, Sendable {
        let modelID: String
        let modelLifecycle: String
        let voiceID: String
        let persona: String
        let filename: String
        let sha256: String
        let byteSize: Int
        let durationSeconds: Double
        let approved: Bool
        let generatedAt: String
        let generationTranscript: String?

        var identity: String { "\(modelID)\u{0}\(voiceID)" }
    }

    let schemaVersion: Int
    let catalogVersion: String
    let status: Status
    let locale: String
    let scriptVersion: String
    let codecVersion: String
    let cdnPath: String
    let cache: Cache
    let scriptLines: [String]
    let entries: [Entry]
    let generatedAt: String

    static let bundledFilename = "live-bn-v1.json"
    static let expectedScriptLines = [
        "আসসালামু আলাইকুম Boss, আমি ALMA।",
        "আপনার কথা মন দিয়ে শুনছি।",
        "বিষয়টি সহজ ও পরিষ্কারভাবে বুঝিয়ে বলব।",
        "আপনি মাঝখানে কথা বললেই আমি থেমে শুনব।",
    ]

    static func decodeStrict(_ data: Data) throws -> Self {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw AlmaLiveVoicePreviewError.malformedCatalog("invalid JSON")
        }
        guard let root = object as? [String: Any] else {
            throw AlmaLiveVoicePreviewError.malformedCatalog("root must be an object")
        }
        try requireExactKeys(
            root,
            expected: ["schemaVersion", "catalogVersion", "status", "locale",
                       "scriptVersion", "codecVersion", "cdnPath", "cache",
                       "scriptLines", "entries", "generatedAt"],
            at: "catalog")
        guard let cache = root["cache"] as? [String: Any] else {
            throw AlmaLiveVoicePreviewError.malformedCatalog("cache must be an object")
        }
        try requireExactKeys(
            cache,
            expected: ["immutable", "memory", "diskLimitBytes",
                       "revalidateAfterSeconds", "checksum"],
            at: "cache")
        guard let entries = root["entries"] as? [Any] else {
            throw AlmaLiveVoicePreviewError.malformedCatalog("entries must be an array")
        }
        let entryKeys: Set<String> = [
            "modelID", "modelLifecycle", "voiceID", "persona", "filename", "sha256",
            "byteSize", "durationSeconds", "approved", "generatedAt", "generationTranscript",
        ]
        for (index, value) in entries.enumerated() {
            guard let entry = value as? [String: Any] else {
                throw AlmaLiveVoicePreviewError.malformedCatalog("entries[\(index)] must be an object")
            }
            try requireExactKeys(entry, expected: entryKeys, at: "entries[\(index)]")
        }

        let catalog: Self
        do {
            catalog = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw AlmaLiveVoicePreviewError.malformedCatalog("schema type mismatch")
        }
        try catalog.validate()
        return catalog
    }

    static func loadBundled(from bundle: Bundle = .main) throws -> Self {
        guard let url = bundle.url(
            forResource: "live-bn-v1", withExtension: "json", subdirectory: "VoicePreviews")
        else { throw AlmaLiveVoicePreviewError.catalogResourceMissing }
        return try decodeStrict(Data(contentsOf: url))
    }

    func entry(modelID: String, voiceID: String) throws -> Entry {
        guard let entry = entries.first(where: {
            $0.modelID == modelID && $0.voiceID == voiceID
        }) else {
            throw AlmaLiveVoicePreviewError.entryNotFound(modelID: modelID, voiceID: voiceID)
        }
        return entry
    }

    private static func requireExactKeys(
        _ object: [String: Any], expected: Set<String>, at path: String
    ) throws {
        guard Set(object.keys) == expected else {
            throw AlmaLiveVoicePreviewError.malformedCatalog("unexpected keys at \(path)")
        }
    }

    private func validate() throws {
        func reject(_ reason: String) throws -> Never {
            throw AlmaLiveVoicePreviewError.malformedCatalog(reason)
        }

        guard schemaVersion == 1 else { try reject("unsupported schemaVersion") }
        guard catalogVersion == "live-bn-v1",
              locale == "bn-BD",
              scriptVersion == "v1",
              codecVersion == "aac-v1",
              cdnPath == "/voice-previews/live-bn-v1/"
        else { try reject("catalog identity mismatch") }
        guard cache.immutable, cache.memory,
              cache.diskLimitBytes == 33_554_432,
              cache.revalidateAfterSeconds == 604_800,
              cache.checksum == "sha256"
        else { try reject("unsupported cache policy") }
        guard scriptLines == Self.expectedScriptLines else { try reject("script mismatch") }
        guard entries.count == 12 else { try reject("catalog must contain exactly 12 entries") }
        guard Self.validISO8601(generatedAt) else { try reject("invalid catalog generatedAt") }

        let models = [
            "gemini-2.5-flash-native-audio-preview-12-2025",
            "gemini-3.1-flash-live-preview",
        ]
        let personas = [
            "Aoede": "মায়া", "Achernar": "নীলা", "Kore": "তারা",
            "Charon": "আরিফ", "Orus": "অর্ক", "Sulafat": "সামি",
        ]
        let expectedIdentities = Set(models.flatMap { model in
            personas.keys.map { "\(model)\u{0}\($0)" }
        })
        guard Set(entries.map(\.identity)) == expectedIdentities else {
            try reject("model/voice matrix mismatch")
        }
        guard Set(entries.map(\.filename)).count == entries.count else {
            try reject("duplicate filename")
        }

        for entry in entries {
            guard entry.modelLifecycle == "preview",
                  personas[entry.voiceID] == entry.persona,
                  entry.byteSize > 0,
                  entry.byteSize <= cache.diskLimitBytes,
                  entry.durationSeconds.isFinite,
                  entry.durationSeconds > 0,
                  Self.validISO8601(entry.generatedAt),
                  Self.isLowercaseSHA256(entry.sha256)
            else { try reject("invalid entry \(entry.identity)") }
            let expectedFilename = entry.modelID.replacingOccurrences(of: ".", with: "-")
                + "--" + entry.voiceID.lowercased()
                + "--\(locale)--\(scriptVersion)--\(codecVersion).m4a"
            guard entry.filename == expectedFilename,
                  Self.isSafeFilename(entry.filename)
            else { try reject("filename identity mismatch for \(entry.identity)") }
        }

        switch status {
        case .generatedPendingOwnerApproval:
            guard !entries.allSatisfy(\.approved) else {
                try reject("fully approved catalog must use release-ready status")
            }
        case .ownerApprovedReleaseReady:
            guard entries.allSatisfy(\.approved) else {
                try reject("release-ready catalog requires 12 approvals")
            }
        }
    }

    fileprivate static func isSafeFilename(_ value: String) -> Bool {
        guard !value.isEmpty,
              value == URL(fileURLWithPath: value).lastPathComponent,
              !value.contains("/"), !value.contains("\\"),
              value.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
                      .contains($0)
              })
        else { return false }
        return value.hasSuffix(".m4a")
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    private static func validISO8601(_ value: String) -> Bool {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if formatter.date(from: value) != nil { return true }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }
}

protocol AlmaLiveVoicePreviewFileAccess: Sendable {
    func readRegularFile(at url: URL, beneath root: URL) throws -> Data?
    func writeAtomically(_ data: Data, to url: URL, beneath root: URL) throws
    func removeRegularFile(at url: URL, beneath root: URL) throws
    func trimRegularFiles(
        beneath root: URL, maximumBytes: Int, preserving urls: Set<URL>
    ) throws
}

struct AlmaLiveVoicePreviewFileSystem: AlmaLiveVoicePreviewFileAccess, @unchecked Sendable {
    private let manager = FileManager.default

    func readRegularFile(at url: URL, beneath root: URL) throws -> Data? {
        let components = try checkedComponents(of: url, beneath: root)
        guard try validateRootDirectoryIfPresent(root) else { return nil }
        var current = root.standardizedFileURL
        for (index, component) in components.enumerated() {
            current.appendPathComponent(component, isDirectory: index < components.count - 1)
            guard let attributes = try attributesIfPresent(at: current) else { return nil }
            let expectedType: FileAttributeType = index == components.count - 1
                ? .typeRegular : .typeDirectory
            guard attributes[.type] as? FileAttributeType == expectedType else {
                throw AlmaLiveVoicePreviewError.unsafePath(current.path)
            }
        }
        // A copied Data value avoids retaining a file-backed mapping after integrity
        // verification while a later cache cleanup mutates the same filesystem path.
        return try Data(contentsOf: current)
    }

    func writeAtomically(_ data: Data, to url: URL, beneath root: URL) throws {
        let components = try checkedComponents(of: url, beneath: root)
        guard !components.isEmpty else { throw AlmaLiveVoicePreviewError.unsafePath(url.path) }
        let directory = url.deletingLastPathComponent().standardizedFileURL
        try rejectExistingSymlinks(from: root.standardizedFileURL, through: directory)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        try rejectExistingSymlinks(from: root.standardizedFileURL, through: directory)
        if let attributes = try attributesIfPresent(at: url.standardizedFileURL) {
            guard attributes[.type] as? FileAttributeType == .typeRegular else {
                throw AlmaLiveVoicePreviewError.unsafePath(url.path)
            }
        }
        try data.write(to: url, options: .atomic)
        let type = try manager.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType
        guard type == .typeRegular else { throw AlmaLiveVoicePreviewError.unsafePath(url.path) }
    }

    func removeRegularFile(at url: URL, beneath root: URL) throws {
        let components = try checkedComponents(of: url, beneath: root)
        guard try validateRootDirectoryIfPresent(root) else { return }
        var current = root.standardizedFileURL
        for (index, component) in components.enumerated() {
            current.appendPathComponent(component, isDirectory: index < components.count - 1)
            guard let attributes = try attributesIfPresent(at: current) else { return }
            let expectedType: FileAttributeType = index == components.count - 1
                ? .typeRegular : .typeDirectory
            guard attributes[.type] as? FileAttributeType == expectedType else {
                throw AlmaLiveVoicePreviewError.unsafePath(current.path)
            }
        }
        try manager.removeItem(at: current)
    }

    func trimRegularFiles(
        beneath root: URL, maximumBytes: Int, preserving urls: Set<URL>
    ) throws {
        guard maximumBytes > 0 else {
            throw AlmaLiveVoicePreviewError.unsafePath("invalid cache limit")
        }
        let root = root.standardizedFileURL
        guard manager.fileExists(atPath: root.path) else { return }
        guard try validateRootDirectoryIfPresent(root) else { return }

        struct Candidate {
            let url: URL
            let bytes: Int
            let modifiedAt: Date
        }
        var candidates: [Candidate] = []
        let keys: Set<URLResourceKey> = [
            .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey,
            .fileSizeKey, .contentModificationDateKey,
        ]
        var traversalError: Error?
        guard let enumerator = manager.enumerator(
            at: root, includingPropertiesForKeys: Array(keys),
            options: [], errorHandler: { _, error in
                traversalError = error
                return false
            })
        else { throw AlmaLiveVoicePreviewError.unsafePath(root.path) }
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: keys)
            guard values.isSymbolicLink != true else {
                throw AlmaLiveVoicePreviewError.unsafePath(url.path)
            }
            if values.isDirectory == true { continue }
            guard values.isRegularFile == true, let bytes = values.fileSize else {
                throw AlmaLiveVoicePreviewError.unsafePath(url.path)
            }
            candidates.append(Candidate(
                url: url.standardizedFileURL,
                bytes: bytes,
                modifiedAt: values.contentModificationDate ?? .distantPast))
        }
        if traversalError != nil {
            throw AlmaLiveVoicePreviewError.unsafePath(root.path)
        }
        var total = candidates.reduce(0) { $0 + $1.bytes }
        guard total > maximumBytes else { return }
        for candidate in candidates.sorted(by: { $0.modifiedAt < $1.modifiedAt }) {
            guard !urls.contains(candidate.url) else { continue }
            try removeRegularFile(at: candidate.url, beneath: root)
            total -= candidate.bytes
            if total <= maximumBytes { return }
        }
        guard total <= maximumBytes else {
            throw AlmaLiveVoicePreviewError.integrityMismatch("cache limit cannot preserve selected asset")
        }
    }

    private func checkedComponents(of url: URL, beneath root: URL) throws -> [String] {
        guard url.isFileURL, root.isFileURL else {
            throw AlmaLiveVoicePreviewError.unsafePath(url.absoluteString)
        }
        let rootPath = root.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard path.hasPrefix(prefix) else { throw AlmaLiveVoicePreviewError.unsafePath(path) }
        let relative = String(path.dropFirst(prefix.count))
        let components = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !components.isEmpty,
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { throw AlmaLiveVoicePreviewError.unsafePath(path) }
        return components
    }

    private func rejectExistingSymlinks(from root: URL, through target: URL) throws {
        let components = try checkedComponents(
            of: target.appendingPathComponent(".__path_check__"), beneath: root).dropLast()
        var current = root
        if let attributes = try attributesIfPresent(at: current) {
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw AlmaLiveVoicePreviewError.unsafePath(current.path)
            }
        }
        for component in components {
            current.appendPathComponent(component, isDirectory: true)
            guard let attributes = try attributesIfPresent(at: current) else { continue }
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw AlmaLiveVoicePreviewError.unsafePath(current.path)
            }
        }
    }

    private func validateRootDirectoryIfPresent(_ root: URL) throws -> Bool {
        guard let attributes = try attributesIfPresent(at: root.standardizedFileURL) else {
            return false
        }
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw AlmaLiveVoicePreviewError.unsafePath(root.path)
        }
        return true
    }

    private func attributesIfPresent(at url: URL) throws -> [FileAttributeKey: Any]? {
        do {
            return try manager.attributesOfItem(atPath: url.path)
        } catch {
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain,
               nsError.code == NSFileNoSuchFileError
                || nsError.code == NSFileReadNoSuchFileError {
                return nil
            }
            throw error
        }
    }
}

struct AlmaLiveVoicePreviewNetworkResponse: Sendable {
    let data: Data
    let statusCode: Int
    let mimeType: String?
    let expectedContentLength: Int64?
    let finalURL: URL?
    let wasRedirected: Bool
}

protocol AlmaLiveVoicePreviewNetworking: Sendable {
    func fetch(_ url: URL, maximumBytes: Int) async throws -> AlmaLiveVoicePreviewNetworkResponse
}

final class AlmaLiveVoicePreviewEphemeralNetwork: AlmaLiveVoicePreviewNetworking, @unchecked Sendable {
    private final class TaskPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var _redirected = false

        var redirected: Bool {
            lock.lock()
            defer { lock.unlock() }
            return _redirected
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            lock.lock()
            _redirected = true
            lock.unlock()
            completionHandler(nil)
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                completionHandler(.performDefaultHandling, nil)
            } else {
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }

    static func productionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.httpAdditionalHeaders = [:]
        return configuration
    }

    func fetch(_ url: URL, maximumBytes: Int) async throws -> AlmaLiveVoicePreviewNetworkResponse {
        guard maximumBytes > 0 else {
            throw AlmaLiveVoicePreviewError.networkRejected("invalid byte ceiling")
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpShouldHandleCookies = false
        request.setValue("audio/mp4, audio/x-m4a", forHTTPHeaderField: "Accept")
        let policy = TaskPolicy()
        let session = URLSession(configuration: Self.productionConfiguration())
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request, delegate: policy)
        if response.expectedContentLength > Int64(maximumBytes) {
            throw AlmaLiveVoicePreviewError.networkRejected("response exceeds byte ceiling")
        }
        var data = Data()
        data.reserveCapacity(min(maximumBytes, max(0, Int(response.expectedContentLength))))
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumBytes else {
                throw AlmaLiveVoicePreviewError.networkRejected("response exceeds byte ceiling")
            }
            data.append(byte)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AlmaLiveVoicePreviewError.networkRejected("non-HTTP response")
        }
        return AlmaLiveVoicePreviewNetworkResponse(
            data: data,
            statusCode: http.statusCode,
            mimeType: http.mimeType,
            expectedContentLength: http.expectedContentLength >= 0
                ? http.expectedContentLength : nil,
            finalURL: http.url,
            wasRedirected: policy.redirected)
    }
}

struct AlmaLiveVoicePreviewAsset: Sendable {
    enum Source: String, Sendable { case memory, disk, bundle, cdn }
    let entry: AlmaLiveVoicePreviewCatalog.Entry
    let data: Data
    let source: Source
}

enum AlmaLiveVoicePreviewEvidenceSource: String, Codable, Equatable, Sendable {
    case memory, disk, bundle, cdn

    init(_ source: AlmaLiveVoicePreviewAsset.Source) {
        switch source {
        case .memory: self = .memory
        case .disk: self = .disk
        case .bundle: self = .bundle
        case .cdn: self = .cdn
        }
    }
}

/// The pre-call preview finishes before a Live session exists. Retain only its
/// latest allow-listed cache tier so the next privacy-safe session report can
/// distinguish preview cache, context compression, and transport resumption.
final class AlmaLiveVoiceCrossPhaseEvidenceStore: @unchecked Sendable {
    static let shared = AlmaLiveVoiceCrossPhaseEvidenceStore()

    private let lock = NSLock()
    private var pendingPreviewSource: AlmaLiveVoicePreviewEvidenceSource?

    func recordPreviewAssetResolved(_ source: AlmaLiveVoicePreviewEvidenceSource) {
        lock.lock()
        pendingPreviewSource = source
        lock.unlock()
    }

    func consumePreviewAssetSource() -> AlmaLiveVoicePreviewEvidenceSource? {
        lock.lock()
        let source = pendingPreviewSource
        pendingPreviewSource = nil
        lock.unlock()
        return source
    }
}

actor AlmaLiveVoicePreviewAssetStore {
    private let catalog: AlmaLiveVoicePreviewCatalog
    private let diskRoot: URL
    private let bundleRoot: URL
    private let cdnBaseURL: URL?
    private let files: any AlmaLiveVoicePreviewFileAccess
    private let network: any AlmaLiveVoicePreviewNetworking
    private var memory: [String: Data] = [:]

    init(
        catalog: AlmaLiveVoicePreviewCatalog,
        diskRoot: URL,
        bundleRoot: URL,
        cdnBaseURL: URL?,
        files: any AlmaLiveVoicePreviewFileAccess = AlmaLiveVoicePreviewFileSystem(),
        network: any AlmaLiveVoicePreviewNetworking = AlmaLiveVoicePreviewEphemeralNetwork()
    ) throws {
        let normalizedDiskRoot = diskRoot.standardizedFileURL
        let normalizedBundleRoot = bundleRoot.standardizedFileURL
        let diskPrefix = normalizedDiskRoot.path + "/"
        let bundlePrefix = normalizedBundleRoot.path + "/"
        guard diskRoot.isFileURL, bundleRoot.isFileURL,
              normalizedDiskRoot.path.hasPrefix("/"), normalizedBundleRoot.path.hasPrefix("/"),
              normalizedDiskRoot.path != "/", normalizedBundleRoot.path != "/",
              normalizedDiskRoot != normalizedBundleRoot,
              !normalizedDiskRoot.path.hasPrefix(bundlePrefix),
              !normalizedBundleRoot.path.hasPrefix(diskPrefix)
        else { throw AlmaLiveVoicePreviewError.unsafePath("asset root must be an absolute file URL") }
        if let cdnBaseURL { try Self.validateCDNBase(cdnBaseURL) }
        self.catalog = catalog
        self.diskRoot = normalizedDiskRoot
        self.bundleRoot = normalizedBundleRoot
        self.cdnBaseURL = cdnBaseURL
        self.files = files
        self.network = network
    }

    static func bundled(
        cdnBaseURL: URL?,
        bundle: Bundle = .main,
        files: any AlmaLiveVoicePreviewFileAccess = AlmaLiveVoicePreviewFileSystem(),
        network: any AlmaLiveVoicePreviewNetworking = AlmaLiveVoicePreviewEphemeralNetwork()
    ) throws -> AlmaLiveVoicePreviewAssetStore {
        let catalog = try AlmaLiveVoicePreviewCatalog.loadBundled(from: bundle)
        guard let resourceRoot = bundle.resourceURL,
              let cacheRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { throw AlmaLiveVoicePreviewError.assetMissing("bundle/cache root") }
        return try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog,
            diskRoot: cacheRoot.appendingPathComponent("ALMA/LiveVoicePreviews", isDirectory: true),
            bundleRoot: resourceRoot.appendingPathComponent("VoicePreviews", isDirectory: true),
            cdnBaseURL: cdnBaseURL,
            files: files,
            network: network)
    }

    func asset(modelID: String, voiceID: String) async throws -> AlmaLiveVoicePreviewAsset {
        try Task.checkCancellation()
        let entry = try catalog.entry(modelID: modelID, voiceID: voiceID)
        let key = entry.identity

        if let data = memory[key] {
            try Self.verify(data, for: entry)
            return AlmaLiveVoicePreviewAsset(entry: entry, data: data, source: .memory)
        }

        let diskURL = try assetURL(root: diskRoot, entry: entry)
        if let data = try files.readRegularFile(at: diskURL, beneath: diskRoot) {
            do {
                try Self.verify(data, for: entry)
                remember(data, key: key)
                return AlmaLiveVoicePreviewAsset(entry: entry, data: data, source: .disk)
            } catch let error as AlmaLiveVoicePreviewError {
                guard case .integrityMismatch = error else { throw error }
                try files.removeRegularFile(at: diskURL, beneath: diskRoot)
            }
        }

        try Task.checkCancellation()
        let bundleURL = try assetURL(root: bundleRoot, entry: entry)
        var bundleIntegrityError: AlmaLiveVoicePreviewError?
        if let data = try files.readRegularFile(at: bundleURL, beneath: bundleRoot) {
            do {
                try Self.verify(data, for: entry)
                try persistVerifiedBestEffort(data, to: diskURL)
                remember(data, key: key)
                return AlmaLiveVoicePreviewAsset(entry: entry, data: data, source: .bundle)
            } catch let error as AlmaLiveVoicePreviewError {
                guard case .integrityMismatch = error else { throw error }
                bundleIntegrityError = error
            }
        }

        try Task.checkCancellation()
        guard let cdnBaseURL else {
            if let bundleIntegrityError { throw bundleIntegrityError }
            throw AlmaLiveVoicePreviewError.assetMissing(entry.filename)
        }
        let remoteURL = try cdnURL(base: cdnBaseURL, filename: entry.filename)
        let response: AlmaLiveVoicePreviewNetworkResponse
        do {
            response = try await network.fetch(remoteURL, maximumBytes: entry.byteSize)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw AlmaLiveVoicePreviewError.networkRejected("request failed")
        }
        try Task.checkCancellation()
        try Self.validate(response, requestedURL: remoteURL, entry: entry)
        try persistVerifiedBestEffort(response.data, to: diskURL)
        remember(response.data, key: key)
        return AlmaLiveVoicePreviewAsset(entry: entry, data: response.data, source: .cdn)
    }

    func purgeMemory() { memory.removeAll(keepingCapacity: false) }

    private func remember(_ data: Data, key: String) {
        if catalog.cache.memory { memory[key] = data }
    }

    private func persistVerified(_ data: Data, to diskURL: URL) throws {
        try files.writeAtomically(data, to: diskURL, beneath: diskRoot)
        try files.trimRegularFiles(
            beneath: diskRoot,
            maximumBytes: catalog.cache.diskLimitBytes,
            preserving: [diskURL.standardizedFileURL])
    }

    private func persistVerifiedBestEffort(_ data: Data, to diskURL: URL) throws {
        // Cache persistence is an optimization. Exact manifest size/SHA verification
        // has already succeeded, so a full/read-only cache must not break offline play.
        do {
            try persistVerified(data, to: diskURL)
        } catch let error as AlmaLiveVoicePreviewError {
            if case .unsafePath = error { throw error }
        } catch {
            // Ordinary cache capacity/permission failures do not invalidate the
            // already checksum-verified playback bytes.
        }
    }

    private func assetURL(
        root: URL, entry: AlmaLiveVoicePreviewCatalog.Entry
    ) throws -> URL {
        guard AlmaLiveVoicePreviewCatalog.isSafeFilename(entry.filename) else {
            throw AlmaLiveVoicePreviewError.unsafePath(entry.filename)
        }
        let versionRoot = root.appendingPathComponent(catalog.catalogVersion, isDirectory: true)
        let url = versionRoot.appendingPathComponent(entry.filename, isDirectory: false).standardizedFileURL
        let prefix = versionRoot.standardizedFileURL.path + "/"
        guard url.path.hasPrefix(prefix), url.lastPathComponent == entry.filename else {
            throw AlmaLiveVoicePreviewError.unsafePath(entry.filename)
        }
        return url
    }

    private func cdnURL(base: URL, filename: String) throws -> URL {
        try Self.validateCDNBase(base)
        guard AlmaLiveVoicePreviewCatalog.isSafeFilename(filename) else {
            throw AlmaLiveVoicePreviewError.unsafePath(filename)
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.path = catalog.cdnPath + filename
        guard let url = components?.url,
              url.scheme?.lowercased() == "https",
              url.host == base.host,
              url.path == catalog.cdnPath + filename,
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil
        else { throw AlmaLiveVoicePreviewError.invalidCDN("unsafe asset URL") }
        return url
    }

    private static func validateCDNBase(_ url: URL) throws {
        guard url.scheme?.lowercased() == "https",
              !(url.host ?? "").isEmpty,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/"
        else { throw AlmaLiveVoicePreviewError.invalidCDN("base must be a credential-free HTTPS origin") }
    }

    private static func validate(
        _ response: AlmaLiveVoicePreviewNetworkResponse,
        requestedURL: URL,
        entry: AlmaLiveVoicePreviewCatalog.Entry
    ) throws {
        guard !response.wasRedirected, response.finalURL == requestedURL else {
            throw AlmaLiveVoicePreviewError.networkRejected("redirect/final URL mismatch")
        }
        guard response.statusCode == 200 else {
            throw AlmaLiveVoicePreviewError.networkRejected("HTTP \(response.statusCode)")
        }
        let mime = response.mimeType?.lowercased()
        guard mime == "audio/mp4" || mime == "audio/x-m4a" else {
            throw AlmaLiveVoicePreviewError.networkRejected("unexpected MIME type")
        }
        if let expectedContentLength = response.expectedContentLength,
           expectedContentLength != Int64(entry.byteSize) {
            throw AlmaLiveVoicePreviewError.networkRejected("Content-Length mismatch")
        }
        try verify(response.data, for: entry)
    }

    private static func verify(
        _ data: Data, for entry: AlmaLiveVoicePreviewCatalog.Entry
    ) throws {
        guard data.count == entry.byteSize else {
            throw AlmaLiveVoicePreviewError.integrityMismatch("size mismatch for \(entry.filename)")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == entry.sha256 else {
            throw AlmaLiveVoicePreviewError.integrityMismatch("SHA-256 mismatch for \(entry.filename)")
        }
    }
}

@MainActor
protocol AlmaLiveVoicePreviewAudioSession: AnyObject {
    func activateForVerifiedPreview() throws
    func deactivateAfterPreview()
    func relinquishWithoutMutatingAudioSession()
}

@MainActor
protocol AlmaLiveVoicePreviewPlayer: AnyObject {
    func playVerifiedData(_ data: Data, onFinished: @escaping @MainActor () -> Void) throws
    func stop()
}

/// AVAudioSession reports `.mixWithOthers` whenever `.duckOthers` is active.
/// Store the normalized option set in every exact-ownership lease so rollback
/// recognizes the configuration iOS actually publishes.
enum AlmaOwnedAudioSessionOptions {
    static let duckingPlayback: AVAudioSession.CategoryOptions = [
        .duckOthers,
        .mixWithOthers,
    ]
}

@MainActor
final class AlmaLiveVoicePreviewSystemAudioSession: AlmaLiveVoicePreviewAudioSession {
    private struct Configuration {
        let category: AVAudioSession.Category
        let mode: AVAudioSession.Mode
        let options: AVAudioSession.CategoryOptions
    }

    private let session: AVAudioSession
    private var ownsPreviewConfiguration = false
    private var previousConfiguration: Configuration?

    init(session: AVAudioSession = .sharedInstance()) { self.session = session }

    func activateForVerifiedPreview() throws {
        let previous = Configuration(
            category: session.category,
            mode: session.mode,
            options: session.categoryOptions)
        previousConfiguration = previous
        ownsPreviewConfiguration = true
        do {
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: AlmaOwnedAudioSessionOptions.duckingPlayback)
            try session.setActive(true)
        } catch {
            rollbackPreviewConfigurationIfStillOwned()
            throw error
        }
    }

    func deactivateAfterPreview() {
        guard ownsPreviewConfiguration else { return }
        rollbackPreviewConfigurationIfStillOwned()
    }

    func relinquishWithoutMutatingAudioSession() {
        ownsPreviewConfiguration = false
        previousConfiguration = nil
    }

    private func rollbackPreviewConfigurationIfStillOwned() {
        guard ownsPreviewConfiguration else { return }
        ownsPreviewConfiguration = false
        let previous = previousConfiguration
        previousConfiguration = nil
        guard session.category == .playback,
              session.mode == .spokenAudio,
              session.categoryOptions == AlmaOwnedAudioSessionOptions.duckingPlayback
        else { return }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        if let previous {
            try? session.setCategory(
                previous.category,
                mode: previous.mode,
                options: previous.options)
        }
    }
}

@MainActor
final class AlmaLiveVoicePreviewSystemPlayer: NSObject, AlmaLiveVoicePreviewPlayer,
    AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var completion: (@MainActor () -> Void)?

    func playVerifiedData(
        _ data: Data, onFinished: @escaping @MainActor () -> Void
    ) throws {
        let player = try AVAudioPlayer(data: data)
        self.player = player
        completion = onFinished
        player.delegate = self
        player.prepareToPlay()
        guard player.play() else {
            self.player = nil
            completion = nil
            throw AlmaLiveVoicePreviewError.audioPlaybackFailed
        }
    }

    func stop() {
        player?.stop()
        player = nil
        completion = nil
    }

    nonisolated static func acceptsCompletion(
        from finishedPlayer: AVAudioPlayer, currentPlayer: AVAudioPlayer?
    ) -> Bool {
        currentPlayer === finishedPlayer
    }

    nonisolated func audioPlayerDidFinishPlaying(
        _ player: AVAudioPlayer, successfully _: Bool
    ) {
        finishIfCurrent(player)
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(
        _ player: AVAudioPlayer, error _: Error?
    ) {
        finishIfCurrent(player)
    }

    nonisolated private func finishIfCurrent(_ finishedPlayer: AVAudioPlayer) {
        Task { @MainActor [weak self] in
            guard let self,
                  Self.acceptsCompletion(from: finishedPlayer, currentPlayer: self.player)
            else { return }
            self.player = nil
            let completion = self.completion
            self.completion = nil
            completion?()
        }
    }
}

struct AlmaLiveVoicePreviewGate: Equatable, Sendable {
    let featureEnabled: Bool
    let callIsActive: Bool

    static func includingNonCallAudio(
        featureEnabled: Bool,
        callIsActive: Bool,
        nonCallAudioIsActive: Bool
    ) -> Self {
        .init(
            featureEnabled: featureEnabled,
            callIsActive: callIsActive || nonCallAudioIsActive)
    }

    @available(iOS 17.0, *)
    @MainActor
    static var productionCallIsActive: Bool {
        let assistantCallActive = AlmaCallBarBridge.shared.engine?.isCallRunning ?? false
        let agentCallActive = AgentCallController.shared.isActive
        let officeAudioActive = OfficeCallCoordinator.shared.mode != .idle
            || OfficeCallCoordinator.shared.isPTTActiveOrStarting
            || OfficeCallCoordinator.shared.audioTeardownPending
        let systemCallPending = CallKitVoIP.shared.hasPendingOrActiveCall
        return assistantCallActive || agentCallActive
            || officeAudioActive || systemCallPending
            || AlmaCallAudioAdmission.shared.isBusy
    }

    @available(iOS 17.0, *)
    @MainActor
    static var production: Self {
        return .includingNonCallAudio(
            featureEnabled: AlmaLiveVoiceRecoveryFeatures.isEnabled(.previewCatalogV1),
            callIsActive: productionCallIsActive,
            nonCallAudioIsActive: AlmaLiveVoiceNonCallAudioRegistry.shared.isBusy)
    }
}

/// Process-global occupancy for app-owned playback/recording that is not a call.
/// All mutation is synchronous on MainActor so a preview admission check and an
/// owner handoff cannot observe a partially-stopped owner.
@MainActor
final class AlmaLiveVoiceNonCallAudioRegistry {
    enum Owner: Equatable, Sendable {
        case assistantTTS
        case composerDictation
        case intercomVoiceNote
        case agentMedia
        case creativeMedia
        case robotSFX
    }

    enum StopMode: Equatable, Sendable {
        case restoreBeforeNextAppMutation
        case relinquishAfterActivatedSystemTakeover
    }

    struct Token: Equatable, Hashable, Sendable {
        fileprivate let registryID: UUID
        fileprivate let generation: UInt64
    }

    typealias StopHandler = @MainActor (StopMode) -> Void

    static let shared = AlmaLiveVoiceNonCallAudioRegistry()

    private struct Entry {
        let owner: Owner
        let token: Token
        let stop: StopHandler
    }

    private enum Operation {
        case claim(Entry)
        case release(Token)
        case stopAll(StopMode)
    }

    private let registryID = UUID()
    private var nextGeneration: UInt64 = 0
    private var activeEntry: Entry?
    private var operations: [Operation] = []
    private var isDraining = false

    var isBusy: Bool { activeEntry != nil }
    var activeOwner: Owner? { activeEntry?.owner }

    init() {}

    @discardableResult
    func claim(_ owner: Owner, stop: @escaping StopHandler) -> Token {
        repeat { nextGeneration &+= 1 } while nextGeneration == 0
        let token = Token(registryID: registryID, generation: nextGeneration)
        operations.append(.claim(Entry(owner: owner, token: token, stop: stop)))
        drainOperations()
        return token
    }

    func release(_ token: Token) {
        operations.append(.release(token))
        drainOperations()
    }

    func stopAll(_ mode: StopMode) {
        operations.append(.stopAll(mode))
        drainOperations()
    }

    private func drainOperations() {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        while !operations.isEmpty {
            switch operations.removeFirst() {
            case let .claim(entry):
                let previous = activeEntry
                activeEntry = nil
                previous?.stop(.restoreBeforeNextAppMutation)
                activeEntry = entry
            case let .release(token):
                guard activeEntry?.token == token else { continue }
                activeEntry = nil
            case let .stopAll(mode):
                let previous = activeEntry
                // Clear first: a callback can synchronously inspect/re-enter the
                // registry without seeing itself or recursively invoking itself.
                activeEntry = nil
                previous?.stop(mode)
            }
        }
    }
}

/// Process-global ownership for call-capable audio paths. A token is valid only
/// for the registry instance and generation that issued it; changing an owner
/// never widens that token's authority.
///
/// Calls are synchronous and MainActor-isolated. During a system takeover the
/// new CallKit entry is installed before either callback runs, so callbacks may
/// safely re-enter the registry without a half-transitioned owner being visible.
@MainActor
final class AlmaCallAudioAdmission {
    enum CallKind: Equatable, Sendable {
        case agent
        case office
    }

    enum CallKitPhase: Int, Equatable, Sendable {
        case reservation
        case reported
        case activating
        case media
        case teardown
    }

    enum Owner: Equatable, Sendable {
        case assistant(engine: ObjectIdentifier)
        case officeIntent(operation: UInt64, callID: String?)
        case officeMedia(operation: UInt64, callID: String?)
        case ptt(generation: UInt64)
        case callKit(uuid: UUID, callID: String, kind: CallKind, phase: CallKitPhase)
    }

    struct Token: Equatable, Hashable, Sendable {
        fileprivate let registryID: UUID
        fileprivate let generation: UInt64
    }

    typealias StopHandler = @MainActor () -> Void
    typealias PreemptHandler = @MainActor () -> Void

    static let shared = AlmaCallAudioAdmission()

    private struct Entry {
        var owner: Owner
        let token: Token
        let stop: StopHandler?
        /// Registered by a normal owner for the bounded, synchronous portion of
        /// teardown that is safe only after PushKit has submitted its required
        /// incoming-call report. This closure belongs to the normal entry until
        /// `claimSystem` transfers it to `pendingDisplacedTeardown`.
        let finishOnSystemPreemption: StopHandler?
        /// A system reservation cannot advance to audio media while the owner it
        /// displaced still has a local graph/socket teardown receipt outstanding.
        var pendingDisplacedTeardown: StopHandler?
        var isTearingDown: Bool
    }

    private var registryID = UUID()
    private var nextGeneration: UInt64 = 0
    private var activeEntry: Entry?

    var isBusy: Bool { activeEntry != nil }
    var activeOwner: Owner? { activeEntry?.owner }
    var isTearingDown: Bool { activeEntry?.isTearingDown ?? false }

    init() {}

    /// Claims an otherwise-vacant app-owned slot. CallKit owners must use
    /// `claimSystem`; a rejected claim has no callback side effects.
    @discardableResult
    func claimNormal(
        _ owner: Owner,
        stop: @escaping StopHandler,
        finishTeardown: StopHandler? = nil
    ) -> Token? {
        guard !owner.isCallKit, activeEntry == nil else { return nil }
        let token = makeToken()
        activeEntry = Entry(
            owner: owner,
            token: token,
            stop: stop,
            finishOnSystemPreemption: finishTeardown,
            pendingDisplacedTeardown: nil,
            isTearingDown: false)
        return token
    }

    /// Reserves CallKit ownership. An exactly-equal duplicate is idempotent and
    /// returns the original token without invoking either callback. A new system
    /// owner may displace only assistant, Office media, or PTT ownership.
    @discardableResult
    func claimSystem(_ owner: Owner, preempt: @escaping PreemptHandler) -> Token? {
        guard owner.isCallKit else { return nil }

        if let activeEntry {
            if activeEntry.owner == owner, activeEntry.owner.isCallKit {
                return activeEntry.token
            }
            guard !activeEntry.isTearingDown,
                  activeEntry.owner.isSystemPreemptible
            else { return nil }

            let displacedStop = activeEntry.stop
            let displacedFinish = activeEntry.finishOnSystemPreemption
            let token = makeToken()
            self.activeEntry = Entry(
                owner: owner,
                token: token,
                stop: nil,
                finishOnSystemPreemption: nil,
                pendingDisplacedTeardown: displacedFinish,
                isTearingDown: false)

            // State is fully transitioned before external code is invoked.
            displacedStop?()
            preempt()
            return token
        }

        let token = makeToken()
        activeEntry = Entry(
            owner: owner,
            token: token,
            stop: nil,
            finishOnSystemPreemption: nil,
            pendingDisplacedTeardown: nil,
            isTearingDown: false)
        return token
    }

    /// Completes the exact displaced owner's post-report local teardown. The
    /// pending closure is cleared before invocation so a reentrant callback is
    /// idempotent and sees the fully-published system owner. No network work is
    /// permitted in this synchronous admission mutation boundary.
    @discardableResult
    func completeSystemPreemption(_ token: Token) -> Bool {
        guard var entry = activeEntry,
              entry.token == token,
              entry.owner.isCallKit
        else { return false }
        let finish = entry.pendingDisplacedTeardown
        entry.pendingDisplacedTeardown = nil
        activeEntry = entry
        finish?()
        return true
    }

    /// Changes only the owner carried by the exact current token. Transitions
    /// are deliberately narrow: an Office intent may materialize its call ID,
    /// become matching Office media or a matching Office CallKit reservation;
    /// a CallKit identity may only advance its phase.
    @discardableResult
    func transition(_ token: Token, to owner: Owner) -> Bool {
        guard var entry = activeEntry,
              entry.token == token,
              !entry.isTearingDown,
              entry.pendingDisplacedTeardown == nil,
              Self.allowsTransition(from: entry.owner, to: owner)
        else { return false }
        entry.owner = owner
        activeEntry = entry
        return true
    }

    func isCurrent(_ token: Token) -> Bool {
        activeEntry?.token == token
    }

    /// Exact just-in-time fence for every operation that can start or mutate a
    /// microphone/playback graph. `isCurrent` deliberately remains true during
    /// teardown so cleanup can authenticate itself; media startup must also prove
    /// the owner has not crossed that terminal boundary.
    func acceptsMediaMutation(_ token: Token) -> Bool {
        guard let entry = activeEntry else { return false }
        return entry.token == token
            && !entry.isTearingDown
            && entry.pendingDisplacedTeardown == nil
    }

    /// Keeps the exact owner admitted while asynchronous audio-session teardown
    /// finishes. No replacement owner can claim the slot until exact release.
    @discardableResult
    func beginTeardown(_ token: Token) -> Bool {
        guard var entry = activeEntry, entry.token == token else { return false }
        entry.isTearingDown = true
        if case let .callKit(uuid, callID, kind, _) = entry.owner {
            entry.owner = .callKit(
                uuid: uuid,
                callID: callID,
                kind: kind,
                phase: .teardown)
        }
        activeEntry = entry
        return true
    }

    func release(_ token: Token) {
        guard let entry = activeEntry, entry.token == token else { return }
        activeEntry = nil
        // A failed CallKit report/reservation may retire the system owner before
        // its normal post-report completion point. Never strand the displaced
        // graph: finish only the exact closure transferred to this system token.
        if entry.owner.isCallKit {
            entry.pendingDisplacedTeardown?()
        }
    }

    /// Test isolation only. Rotating the registry UUID guarantees every token
    /// issued before a reset remains stale even if generations restart at one.
    func resetForTests() {
        activeEntry = nil
        registryID = UUID()
        nextGeneration = 0
    }

    private func makeToken() -> Token {
        repeat { nextGeneration &+= 1 } while nextGeneration == 0
        return Token(registryID: registryID, generation: nextGeneration)
    }

    private static func allowsTransition(from current: Owner, to next: Owner) -> Bool {
        if current == next { return true }

        switch (current, next) {
        case let (
            .officeIntent(currentOperation, currentCallID),
            .officeIntent(nextOperation, nextCallID)
        ):
            guard currentOperation == nextOperation else { return false }
            return currentCallID == nil || currentCallID == nextCallID

        case let (
            .officeIntent(currentOperation, currentCallID),
            .officeMedia(nextOperation, nextCallID)
        ):
            guard currentOperation == nextOperation else { return false }
            return currentCallID == nil || currentCallID == nextCallID

        case let (
            .officeIntent(_, currentCallID),
            .callKit(_, nextCallID, kind, phase)
        ):
            return currentCallID == nextCallID
                && kind == .office
                && phase == .reservation

        case let (
            .callKit(currentUUID, currentCallID, currentKind, currentPhase),
            .callKit(nextUUID, nextCallID, nextKind, nextPhase)
        ):
            return currentUUID == nextUUID
                && currentCallID == nextCallID
                && currentKind == nextKind
                && nextPhase.rawValue > currentPhase.rawValue

        default:
            return false
        }
    }
}

private extension AlmaCallAudioAdmission.Owner {
    var isCallKit: Bool {
        if case .callKit = self { return true }
        return false
    }

    var isSystemPreemptible: Bool {
        switch self {
        case .assistant, .officeMedia, .ptt:
            return true
        case .officeIntent, .callKit:
            return false
        }
    }
}

/// Pure identity fence for the CallKit terminal path that never reached
/// didActivate (and therefore will never receive a matching didDeactivate).
/// A nil pending token represents failure before the Office coordinator adopted
/// the already-reserved system token; canonical call identity still stays exact.
enum AlmaCallKitPreActivationTerminalFence {
    static func accepts(
        pendingCallID: String?,
        pendingToken: AlmaCallAudioAdmission.Token?,
        terminalCallID: String,
        terminalToken: AlmaCallAudioAdmission.Token
    ) -> Bool {
        guard pendingCallID?.caseInsensitiveCompare(terminalCallID) == .orderedSame
        else { return false }
        return pendingToken == nil || pendingToken == terminalToken
    }
}

/// A synchronous, MainActor-owned safety interlock. App-owned playback, recording,
/// call and PTT entry points call it before taking AVAudioSession so an active
/// preview cannot leak into a newer audio owner.
@MainActor
final class AlmaLiveVoicePreviewTakeoverRelay {
    static let shared = AlmaLiveVoicePreviewTakeoverRelay()
    private weak var activeCoordinator: AlmaLiveVoicePreviewCoordinator?

    private init() {}

    func claimForPreview(_ coordinator: AlmaLiveVoicePreviewCoordinator) {
        guard activeCoordinator !== coordinator else { return }
        let previous = activeCoordinator
        activeCoordinator = coordinator
        previous?.stopForPreviewReplacement()
    }

    func release(_ coordinator: AlmaLiveVoicePreviewCoordinator) {
        if activeCoordinator === coordinator { activeCoordinator = nil }
    }

    func stopBeforeAudioTakeover() {
        AlmaLiveVoiceNonCallAudioRegistry.shared.stopAll(
            .relinquishAfterActivatedSystemTakeover)
        if #available(iOS 17.0, *) {
            OfficeCallCoordinator.shared.relinquishPendingAudioTeardownWithoutMutation()
        }
        let coordinator = activeCoordinator
        activeCoordinator = nil
        coordinator?.stopBeforeAudioTakeover(restoringPreviewSession: false)
    }

    /// Use only before the next in-process owner mutates AVAudioSession. At that
    /// point the preview still owns the process-global session, so it is safe and
    /// necessary to restore the true pre-preview configuration first.
    @discardableResult
    func stopAndRestoreBeforeAudioTakeover() -> Bool {
        if #available(iOS 17.0, *) {
            guard OfficeCallCoordinator.shared.finishPendingAudioTeardownBeforeNewOwner()
            else { return false }
        }
        AlmaLiveVoiceNonCallAudioRegistry.shared.stopAll(.restoreBeforeNextAppMutation)
        let coordinator = activeCoordinator
        activeCoordinator = nil
        coordinator?.stopBeforeAudioTakeover(restoringPreviewSession: true)
        return true
    }

    /// Atomically admit a non-call audio owner after its final suspension point.
    /// The first check avoids disturbing preview/audio state while a call already
    /// owns the process session. The second closes a call-reservation race during
    /// preview/Office teardown; a later system-call reservation synchronously
    /// invokes `stopBeforeAudioTakeover()` and cancels the newly registered owner.
    @available(iOS 17.0, *)
    @discardableResult
    func claimNonCallAudio(
        _ owner: AlmaLiveVoiceNonCallAudioRegistry.Owner,
        stop: @escaping AlmaLiveVoiceNonCallAudioRegistry.StopHandler
    ) -> AlmaLiveVoiceNonCallAudioRegistry.Token? {
        guard !AlmaLiveVoicePreviewGate.productionCallIsActive,
              stopAndRestoreBeforeAudioTakeover(),
              !AlmaLiveVoicePreviewGate.productionCallIsActive
        else { return nil }
        return AlmaLiveVoiceNonCallAudioRegistry.shared.claim(owner, stop: stop)
    }
}

@MainActor
final class AlmaLiveVoicePreviewCoordinator {
    enum Failure: Equatable {
        case catalog
        case unavailable
        case integrity
        case network
        case audio
    }

    enum RequestDecision: Equatable {
        case started(UInt64)
        case blockedFeatureOff
        case blockedActiveCall
        case blockedShutdown
    }

    enum State: Equatable {
        case idle
        case loading(UInt64)
        case playing(UInt64, modelID: String, voiceID: String)
        case failed(UInt64, Failure)
        case stopped(UInt64)
    }

    enum LifecycleEvent: Sendable {
        case interruption
        case routeChange
        case willResignActive
        case background
        case mediaServicesReset
    }

    private final class ObservationBag {
        let center: NotificationCenter
        var tokens: [NSObjectProtocol] = []
        init(center: NotificationCenter) { self.center = center }
        deinit { tokens.forEach(center.removeObserver) }
    }

    private let store: AlmaLiveVoicePreviewAssetStore
    private let audioSession: any AlmaLiveVoicePreviewAudioSession
    private let player: any AlmaLiveVoicePreviewPlayer
    private let currentAdmission: @MainActor () -> AlmaLiveVoicePreviewGate
    private var observationBag: ObservationBag?
    private var loadTask: Task<Void, Never>?
    private var ownsAudioSession = false
    private var hasTakeoverClaim = false
    private var isShutdown = false
    private var generation: UInt64 = 0
    private(set) var state: State = .idle
    private(set) var lastResolvedSource: AlmaLiveVoicePreviewAsset.Source?

    init(
        store: AlmaLiveVoicePreviewAssetStore,
        audioSession: (any AlmaLiveVoicePreviewAudioSession)? = nil,
        player: (any AlmaLiveVoicePreviewPlayer)? = nil,
        admission: @escaping @MainActor () -> AlmaLiveVoicePreviewGate,
        notificationCenter: NotificationCenter? = .default
    ) {
        self.store = store
        self.audioSession = audioSession ?? AlmaLiveVoicePreviewSystemAudioSession()
        self.player = player ?? AlmaLiveVoicePreviewSystemPlayer()
        self.currentAdmission = admission
        if let notificationCenter { installObservers(notificationCenter) }
    }

    deinit {
        loadTask?.cancel()
        guard ownsAudioSession else { return }
        let player = player
        let audioSession = audioSession
        // Production owners must call synchronous `shutdown()` before release.
        // This fallback stops only the coordinator-owned player and abandons its
        // lease without mutating the process-global session: a deferred deinit
        // must never deactivate a newer CallKit/Agora/ringtone owner.
        Task { @MainActor in
            player.stop()
            audioSession.relinquishWithoutMutatingAudioSession()
        }
    }

    @discardableResult
    func play(
        modelID: String,
        voiceID: String
    ) -> RequestDecision {
        guard !isShutdown else { return .blockedShutdown }
        let gate = currentAdmission()
        guard gate.featureEnabled else {
            stopCurrentPreviewForAdmissionBlock()
            return .blockedFeatureOff
        }
        guard !gate.callIsActive else {
            stopCurrentPreviewForAdmissionBlock()
            return .blockedActiveCall
        }

        generation += 1
        let requestGeneration = generation
        cancelCurrentWork(updateState: false)
        lastResolvedSource = nil
        state = .loading(requestGeneration)
        AlmaLiveVoicePreviewTakeoverRelay.shared.claimForPreview(self)
        hasTakeoverClaim = true
        loadTask = Task { [weak self, store] in
            do {
                let asset = try await store.asset(modelID: modelID, voiceID: voiceID)
                try Task.checkCancellation()
                guard let self,
                      self.generation == requestGeneration,
                      self.state == .loading(requestGeneration)
                else { return }
                self.lastResolvedSource = asset.source
                AlmaLiveVoiceCrossPhaseEvidenceStore.shared.recordPreviewAssetResolved(
                    AlmaLiveVoicePreviewEvidenceSource(asset.source))

                let latestAdmission = self.currentAdmission()
                guard latestAdmission.featureEnabled, !latestAdmission.callIsActive else {
                    self.releaseTakeoverClaim()
                    self.state = .stopped(requestGeneration)
                    return
                }

                // No session mutation occurs until the selected bytes have passed exact
                // manifest size and SHA-256 verification inside the isolated asset store.
                do {
                    try self.audioSession.activateForVerifiedPreview()
                } catch {
                    self.releaseTakeoverClaim()
                    throw AlmaLiveVoicePreviewError.audioPlaybackFailed
                }
                self.ownsAudioSession = true
                self.state = .playing(
                    requestGeneration, modelID: asset.entry.modelID, voiceID: asset.entry.voiceID)
                do {
                    try self.player.playVerifiedData(asset.data) { [weak self] in
                        guard let self, self.generation == requestGeneration else { return }
                        self.finish(requestGeneration)
                    }
                } catch {
                    self.releaseAudioSession()
                    throw AlmaLiveVoicePreviewError.audioPlaybackFailed
                }
                guard self.generation == requestGeneration else {
                    self.cancelCurrentWork(updateState: false)
                    return
                }
                guard case let .playing(stateGeneration, _, _) = self.state,
                      stateGeneration == requestGeneration
                else { return }
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.generation == requestGeneration else { return }
                self.releaseAudioSession()
                self.releaseTakeoverClaim()
                self.state = .failed(requestGeneration, Self.safeFailure(error))
            }
        }
        return .started(requestGeneration)
    }

    func stop() {
        generation += 1
        cancelCurrentWork(updateState: true)
    }

    func shutdown() {
        guard !isShutdown else { return }
        isShutdown = true
        generation += 1
        cancelCurrentWork(updateState: true)
        observationBag = nil
    }

    func reconcileAdmission() {
        let gate = currentAdmission()
        if !gate.featureEnabled || gate.callIsActive {
            stopCurrentPreviewForAdmissionBlock()
        }
    }

    func handleLifecycle(_ event: LifecycleEvent) {
        generation += 1
        cancelCurrentWork(updateState: true)
        // Deliberately no retained selection and no resume path for any lifecycle event.
        _ = event
    }

    func waitForCurrentRequest() async { await loadTask?.value }

    private func cancelCurrentWork(updateState: Bool) {
        loadTask?.cancel()
        loadTask = nil
        if ownsAudioSession {
            player.stop()
            releaseAudioSession()
        }
        releaseTakeoverClaim()
        if updateState { state = .stopped(generation) }
    }

    private func stopCurrentPreviewForAdmissionBlock() {
        switch state {
        case .loading, .playing:
            generation += 1
            cancelCurrentWork(updateState: true)
        case .idle, .failed, .stopped:
            break
        }
    }

    fileprivate func stopForPreviewReplacement() {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        if ownsAudioSession {
            player.stop()
            ownsAudioSession = false
            audioSession.deactivateAfterPreview()
        }
        hasTakeoverClaim = false
        state = .stopped(generation)
    }

    fileprivate func stopBeforeAudioTakeover(restoringPreviewSession: Bool) {
        generation += 1
        loadTask?.cancel()
        loadTask = nil
        if ownsAudioSession {
            player.stop()
            ownsAudioSession = false
            if restoringPreviewSession {
                audioSession.deactivateAfterPreview()
            } else {
                audioSession.relinquishWithoutMutatingAudioSession()
            }
        }
        hasTakeoverClaim = false
        state = .stopped(generation)
    }

    private func releaseAudioSession() {
        guard ownsAudioSession else { return }
        ownsAudioSession = false
        releaseTakeoverClaim()
        let admission = currentAdmission()
        if admission.callIsActive {
            audioSession.relinquishWithoutMutatingAudioSession()
        } else {
            audioSession.deactivateAfterPreview()
        }
    }

    private func releaseTakeoverClaim() {
        guard hasTakeoverClaim else { return }
        hasTakeoverClaim = false
        AlmaLiveVoicePreviewTakeoverRelay.shared.release(self)
    }

    private func finish(_ requestGeneration: UInt64) {
        guard generation == requestGeneration else { return }
        releaseAudioSession()
        state = .idle
    }

    private static func safeFailure(_ error: Error) -> Failure {
        guard let error = error as? AlmaLiveVoicePreviewError else { return .unavailable }
        switch error {
        case .malformedCatalog, .catalogResourceMissing, .entryNotFound:
            return .catalog
        case .unsafePath, .integrityMismatch:
            return .integrity
        case .invalidCDN, .networkRejected:
            return .network
        case .assetMissing:
            return .unavailable
        case .audioPlaybackFailed:
            return .audio
        }
    }

    private func installObservers(_ center: NotificationCenter) {
        let bag = ObservationBag(center: center)
        bag.tokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began
            else { return }
            MainActor.assumeIsolated { self?.handleLifecycle(.interruption) }
        })
        bag.tokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory
            else { return }
            MainActor.assumeIsolated { self?.handleLifecycle(.routeChange) }
        })
        bag.tokens.append(center.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconcileAdmission() }
        })
        let mappings: [(Notification.Name, LifecycleEvent)] = [
            (UIApplication.willResignActiveNotification, .willResignActive),
            (UIApplication.didEnterBackgroundNotification, .background),
            (AVAudioSession.mediaServicesWereLostNotification, .mediaServicesReset),
            (AVAudioSession.mediaServicesWereResetNotification, .mediaServicesReset),
        ]
        bag.tokens.append(contentsOf: mappings.map { name, event in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.handleLifecycle(event) }
            }
        })
        observationBag = bag
    }
}
