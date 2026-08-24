//
//  TradingUploadFingerprint.swift
//  ALMA ERP — the client-side upload fingerprint the web has always sent.
//
//  `POST /api/trading/accounts/{id}/performance` accepts an optional
//  `fingerprint` field and uses it as a second duplicate guard, on top of the
//  server's own content hash. The web computes it in
//  src/lib/trading-upload-guard.ts; iOS was uploading without it, so a retry of
//  the same shot leaned on the server hash alone.
//
//  The format is the web's verbatim — `"<byteCount>:<first 32 hex of SHA-256 of
//  the first 96 KB>"` — so both clients produce the same value for one image and
//  the server can compare them.
//

import Foundation
import CryptoKit

enum TradingUploadFingerprint {
    /// Web `fingerprintFile`: hash at most the leading 96 KB, prefix the size.
    static func make(_ data: Data) -> String {
        let slice = data.count > 96_000 ? data.prefix(96_000) : data.prefix(data.count)
        let digest = SHA256.hash(data: slice)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "\(data.count):\(hex.prefix(32))"
    }
}
