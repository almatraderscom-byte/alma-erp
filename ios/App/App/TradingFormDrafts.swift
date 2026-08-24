//
//  TradingFormDrafts.swift
//  ALMA ERP — half-typed trading entries survive the sheet closing.
//
//  The web has kept these since src/lib/trading-drafts.ts: the trade modal, the
//  bKash summary and the screenshot form autosave to localStorage and restore
//  themselves on reopen. iOS had nothing, which is backwards — a phone is where
//  a call, a switch to Telegram to re-read the numbers, or the app being evicted
//  actually interrupts data entry.
//
//  Same three keys as the web so the two stay recognisably one feature. Stored
//  in UserDefaults rather than the keychain: this is a partially-typed form, not
//  a secret, and it is cleared the moment the entry is submitted.
//
//  Drafts expire — restoring yesterday's half-typed rate onto today's screen
//  would be worse than starting empty.
//

import Foundation

enum TradingFormDrafts {
    private static let prefix = "alma-trading-draft:"
    /// Web keeps drafts until they are used; a stale one on a phone is more
    /// likely to be forgotten than resumed, so it ages out after a day.
    private static let maxAge: TimeInterval = 24 * 60 * 60

    /// The Add Trade sheet — both modes, because the sheet switches between them.
    struct Trade: Codable, Equatable {
        var accountId = ""
        var mode = "BANK"
        var tradeType = "BUY"
        var usdtAmount = ""
        var bdtRate = ""
        var feeUsdt = ""
        var notes = ""
        var bkashDate = ""
        var bkashOrders = ""
        var bkashProfit = ""
        var bkashLoss = ""
        var savedAt = Date()

        /// `savedAt` is deliberately outside equality: the snapshot is rebuilt on
        /// every SwiftUI evaluation, so a fresh timestamp would make onChange fire
        /// forever and rewrite the draft on every frame.
        static func == (a: Trade, b: Trade) -> Bool {
            a.accountId == b.accountId && a.mode == b.mode && a.tradeType == b.tradeType
                && a.usdtAmount == b.usdtAmount && a.bdtRate == b.bdtRate
                && a.feeUsdt == b.feeUsdt && a.notes == b.notes
                && a.bkashDate == b.bkashDate && a.bkashOrders == b.bkashOrders
                && a.bkashProfit == b.bkashProfit && a.bkashLoss == b.bkashLoss
        }

        /// Nothing typed yet — do not litter storage, and do not offer to restore
        /// an empty form.
        var isEmpty: Bool {
            [usdtAmount, bdtRate, feeUsdt, notes, bkashOrders, bkashProfit, bkashLoss]
                .allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty }
        }
    }

    /// The compliance screenshot form. The image itself is never stored — only
    /// the fields typed around it.
    struct Screenshot: Codable, Equatable {
        var accountId = ""
        var shotDate = ""
        var note = ""
        var savedAt = Date()

        static func == (a: Screenshot, b: Screenshot) -> Bool {
            a.accountId == b.accountId && a.shotDate == b.shotDate && a.note == b.note
        }

        var isEmpty: Bool { note.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    static func load<T: Codable>(_ key: String, as type: T.Type, savedAt: (T) -> Date) -> T? {
        guard let data = UserDefaults.standard.data(forKey: prefix + key),
              let draft = try? JSONDecoder().decode(T.self, from: data)
        else { return nil }
        guard Date().timeIntervalSince(savedAt(draft)) < maxAge else {
            clear(key)
            return nil
        }
        return draft
    }

    static func save<T: Codable>(_ key: String, _ draft: T) {
        guard let data = try? JSONEncoder().encode(draft) else { return }
        UserDefaults.standard.set(data, forKey: prefix + key)
    }

    static func clear(_ key: String) {
        UserDefaults.standard.removeObject(forKey: prefix + key)
    }

    // Web key names, verbatim.
    static let tradeKey = "trade"
    static let screenshotKey = "screenshot"

    static func loadTrade() -> Trade? { load(tradeKey, as: Trade.self) { $0.savedAt } }
    static func loadScreenshot() -> Screenshot? { load(screenshotKey, as: Screenshot.self) { $0.savedAt } }
}
