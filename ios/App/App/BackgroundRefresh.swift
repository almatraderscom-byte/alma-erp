//
//  BackgroundRefresh.swift
//  App
//
//  Phase N4 — periodic background refresh so the owner's reminders stay fresh even
//  if the app isn't opened for days. A BGAppRefreshTask wakes the app, reuses the
//  live WKWebView session cookie to call the (owner-only) reminders feed, and
//  re-schedules local notifications natively via UNUserNotificationCenter.
//
//  AUTH DECISION (documented in agent-ios-native-handoff.md §Phase N4): we reuse the
//  existing NextAuth session cookie from WKWebsiteDataStore rather than minting a
//  device token — so there is NO database change (stays additive) and nothing new to
//  revoke. If the cookie has expired the fetch simply 401s and we no-op until the
//  owner next opens the app (which re-syncs via the web local-reminders path).
//
//  Notification ids match the web scheme (src/lib/local-reminders.ts
//  reminderNotificationId — a 31-hash of the reminder uuid) so the same reminder
//  scheduled by the web path and by this background path DEDUPES instead of
//  double-firing (both land in UNUserNotificationCenter under the same identifier).
//
//  Fully fail-open: any error (no cookie, offline, 401, decode failure) ends the
//  task cleanly. Background tasks run on DEVICE only (not the simulator).
//

import BackgroundTasks
import Foundation
import UserNotifications
import WebKit

enum BackgroundRefresh {
    /// Must match Info.plist `BGTaskSchedulerPermittedIdentifiers`.
    static let taskIdentifier = "com.almatraders.erp.refresh"

    /// Production origin the WKWebView loads (capacitor.config allowNavigation).
    private static let origin = "https://alma-erp-six.vercel.app"

    private struct Reminder: Decodable {
        let id: String
        let title: String
        let body: String?
        let dueAt: String
    }

    // MARK: - Registration + scheduling

    /// Register the task handler. MUST be called before `didFinishLaunching` returns.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refreshTask)
        }
    }

    /// Ask iOS to wake us again no sooner than ~1 hour from now. iOS decides the real
    /// cadence based on usage; this only sets the floor.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    // MARK: - Handler

    private static func handle(_ task: BGAppRefreshTask) {
        schedule() // always queue the next window first

        let work = Task {
            await refreshReminders()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = {
            work.cancel()
        }
    }

    private static func refreshReminders() async {
        let cookies = await loadCookies()
        guard let url = URL(string: "\(origin)/api/assistant/device-reminders") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        let scoped = cookies.filter { $0.domain.contains("alma-erp-six.vercel.app") }
        guard !scoped.isEmpty else { return } // not logged in on this device → no-op
        for (field, value) in HTTPCookie.requestHeaderFields(with: scoped) {
            request.setValue(value, forHTTPHeaderField: field)
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let decoded = try JSONDecoder().decode([String: [Reminder]].self, from: data)
            let reminders = decoded["reminders"] ?? []
            await scheduleNotifications(reminders)
        } catch {
            // offline / decode failure — fail-open, try again next window
        }
    }

    // MARK: - Cookies (WKWebView session reuse)

    @MainActor
    private static func loadCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
    }

    // MARK: - Local notifications

    private static func scheduleNotifications(_ reminders: [Reminder]) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else { return }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallbackFormatter = ISO8601DateFormatter() // some payloads lack fractional seconds

        let now = Date()
        for reminder in reminders {
            let due = formatter.date(from: reminder.dueAt) ?? fallbackFormatter.date(from: reminder.dueAt)
            guard let due = due, due > now else { continue }

            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = (reminder.body?.isEmpty == false ? reminder.body! : "ALMA ERP রিমাইন্ডার")
            content.sound = .default

            let components = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: due)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let identifier = String(reminderNotificationId(reminder.id))
            let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    /// Stable positive id from a reminder uuid — a 31-hash matching the web's
    /// `reminderNotificationId` (src/lib/local-reminders.ts) EXACTLY so the same
    /// reminder dedupes across the web and background scheduling paths.
    static func reminderNotificationId(_ uuid: String) -> Int {
        var hash: Int32 = 0
        for unit in uuid.utf16 {
            hash = hash &* 31 &+ Int32(unit)
        }
        let magnitude = Int(hash.magnitude)
        return magnitude == 0 ? 1 : magnitude
    }
}
