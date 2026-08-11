import Foundation

/// A closed vocabulary emitted by the build-provenance gate. The final case is
/// runtime-only: the build must never claim that it authored an invalid bundle.
enum AlmaBuildProvenanceStatus: String, Codable, CaseIterable, Sendable {
    case verifiedCleanSourceAndBundledInputs = "verified-clean-source-and-bundled-inputs"
    case unavailableRepository = "unavailable-repository"
    case unavailableDirtyWorktree = "unavailable-dirty-worktree"
    case unavailableUntrustedInputPath = "unavailable-untrusted-input-path"
    case unavailableBundledInputMismatch = "unavailable-bundled-input-mismatch"
    case unavailableProductCopyMismatch = "unavailable-product-copy-mismatch"
    case unavailableInvalidBundleProvenance = "unavailable-invalid-bundle-provenance"
}

/// Runtime view of the generated bundle resource. `trustedCommit` is the only
/// commit value consumers may display or transmit.
struct AlmaBuildProvenance: Equatable, Sendable {
    let revisionStatus: AlmaBuildProvenanceStatus
    let trustedCommit: String?

    var evidenceCommit: String { trustedCommit ?? "unknown" }

    fileprivate init(
        revisionStatus: AlmaBuildProvenanceStatus,
        trustedCommit: String?
    ) {
        self.revisionStatus = revisionStatus
        self.trustedCommit = trustedCommit
    }

    fileprivate static let invalid = AlmaBuildProvenance(
        revisionStatus: .unavailableInvalidBundleProvenance,
        trustedCommit: nil)
}

/// One shared production snapshot plus a deterministic data entry point for
/// unit tests. Missing, malformed, extended, or contradictory input fails
/// closed and never falls back to the legacy Info.plist stamp.
enum AlmaBuildProvenanceLoader {
    static let current = load(bundle: .main)

    private static let resourceName = "alma-build-provenance"
    private static let resourceExtension = "plist"
    private static let verifiedKeys: Set<String> = [
        "schemaVersion", "revisionStatus", "commit",
    ]
    private static let unavailableKeys: Set<String> = [
        "schemaVersion", "revisionStatus",
    ]
    static func load(bundle: Bundle) -> AlmaBuildProvenance {
        guard let url = bundle.url(
            forResource: resourceName,
            withExtension: resourceExtension),
              let data = try? Data(contentsOf: url, options: .mappedIfSafe)
        else { return .invalid }
        return load(data: data)
    }

    static func load(data: Data) -> AlmaBuildProvenance {
        guard let object = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil),
              let dictionary = object as? [String: Any],
              schemaVersion(dictionary["schemaVersion"]) == 1,
              let rawStatus = dictionary["revisionStatus"] as? String,
              let status = AlmaBuildProvenanceStatus(rawValue: rawStatus)
        else { return .invalid }

        if status == .verifiedCleanSourceAndBundledInputs {
            guard Set(dictionary.keys) == verifiedKeys,
                  let commit = dictionary["commit"] as? String,
                  isFullLowercaseCommit(commit)
            else { return .invalid }
            return AlmaBuildProvenance(
                revisionStatus: status,
                trustedCommit: commit)
        }

        guard Set(dictionary.keys) == unavailableKeys else { return .invalid }
        return AlmaBuildProvenance(revisionStatus: status, trustedCommit: nil)
    }

    private static func schemaVersion(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber else { return nil }
        // Property-list booleans and reals also bridge to NSNumber. Only an
        // integer encoding is an acceptable schema discriminator.
        let encoding = String(cString: number.objCType)
        guard ["s", "i", "l", "q", "S", "I", "L", "Q"].contains(encoding)
        else { return nil }
        return number.intValue
    }

    private static func isFullLowercaseCommit(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 40 || bytes.count == 64 else { return false }
        return bytes.allSatisfy { byte in
            (48...57).contains(byte) || (97...102).contains(byte)
        }
    }
}
