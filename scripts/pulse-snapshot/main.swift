import SwiftUI
import UIKit

@available(iOS 16.1, *)
func st(
    mode: PulseMode,
    headline: String,
    subtitle: String,
    tasks: Int = 7, approvals: Int = 3, orders: Int = 4,
    progress: Double? = nil,
    items: [PulseItem] = [],
    approvalTitle: String? = nil, counterparty: String? = nil, amount: String? = nil,
    alertTitle: String? = nil, alertDetail: String? = nil,
    successTitle: String? = nil, successDetail: String? = nil
) -> PulseActivityAttributes.ContentState {
    var s = PulseActivityAttributes.ContentState(
        ordersToday: 5, statusLine: "সর্বশেষ: পেন্ডিং", updatedAt: nil,
        pendingApprovals: approvals, openTasks: tasks
    )
    s.mode = mode.rawValue
    s.headline = headline
    s.subtitle = subtitle
    s.pendingTaskCount = tasks
    s.approvalCount = approvals
    s.runningOrderCount = orders
    s.orderProgress = progress
    s.items = items
    s.updatedAtEpoch = Date().timeIntervalSince1970
    s.staleAfterEpoch = Date().addingTimeInterval(900).timeIntervalSince1970
    s.approvalTitle = approvalTitle
    s.approvalCounterparty = counterparty
    s.approvalAmountText = amount
    s.alertTitle = alertTitle
    s.alertDetail = alertDetail
    s.successTitle = successTitle
    s.successDetail = successDetail
    return s
}

@available(iOS 16.1, *)
func item(_ id: String, _ kind: String, _ title: String, _ sub: String,
          _ value: String? = nil, _ progress: Double? = nil, _ sev: String = "normal") -> PulseItem {
    PulseItem(id: id, kind: kind, title: title, subtitle: sub, valueText: value,
              progress: progress, severity: sev, createdAtEpoch: Date().timeIntervalSince1970,
              link: "almaerp://orders/running")
}

@available(iOS 16.1, *)
func cases() -> [(String, PulseActivityAttributes.ContentState, PulseMode)] {
    let approvalItem = item("a1", "approval", "লেজার এন্ট্রি — ধার পরিশোধ", "Hossain Mama", "৳৪৮,৫০০", nil, "attention")
    let ordersItem = item("o1", "orderProgress", "৪টি অর্ডার চলছে", "২ কনফার্মড · ২ পেন্ডিং", "৪", 0.5)
    let tasksItem = item("t1", "pendingTask", "বাকি কাজ", "৭টি কাজ অপেক্ষায়", "৭")
    let stockItem = item("s1", "stockAlert", "স্টক গরমিল ধরা পড়েছে", "ALM-351 · ৬ পিস মিলছে না", nil, nil, "urgent")

    return [
        ("1-overview", st(mode: .overview, headline: "ব্যবসা স্বাভাবিক চলছে", subtitle: "১০টি বিষয়ে নজর দিন",
                          items: [ordersItem, tasksItem]), .overview),
        ("2-working", st(mode: .working, headline: "কাজ চলছে", subtitle: "এজেন্ট এখন কাজ করছে",
                         orders: 0, items: [tasksItem]), .working),
        ("3-approval", st(mode: .approval, headline: "আপনার অনুমোদনেই পরের ধাপ", subtitle: "লেজার এন্ট্রি — অপেক্ষায়",
                          items: [approvalItem, ordersItem, tasksItem],
                          approvalTitle: "লেজার এন্ট্রি — ধার পরিশোধ", counterparty: "Hossain Mama", amount: "৳৪৮,৫০০"), .approval),
        ("4-orders", st(mode: .orders, headline: "৪টি অর্ডার চলছে", subtitle: "২ কনফার্মড · ২ পেন্ডিং",
                        approvals: 0, progress: 0.5, items: [ordersItem, tasksItem]), .orders),
        ("5-urgent", st(mode: .urgent, headline: "স্টক গরমিল ধরা পড়েছে", subtitle: "ALM-351 · ৬ পিস মিলছে না",
                        items: [stockItem, approvalItem, ordersItem],
                        alertTitle: "স্টক গরমিল ধরা পড়েছে", alertDetail: "ALM-351 · ৬ পিস মিলছে না"), .urgent),
        ("6-success", st(mode: .success, headline: "অনুমোদন হয়েছে", subtitle: "পেমেন্ট ছাড়া হয়েছে, কাজ এগোচ্ছে",
                         approvals: 0, items: [ordersItem, tasksItem],
                         successTitle: "অনুমোদন হয়েছে", successDetail: "পেমেন্ট ছাড়া হয়েছে, কাজ এগোচ্ছে"), .success),
        ("7-stale", st(mode: .stale, headline: "তথ্য পুরনো হতে পারে", subtitle: "সর্বশেষ আপডেট ১২ মিনিট আগে",
                       items: [ordersItem]), .stale),
        ("8-offline", st(mode: .offline, headline: "সংযোগের অপেক্ষায়", subtitle: "সর্বশেষ পাওয়া তথ্য দেখাচ্ছে",
                         items: [ordersItem]), .offline),
        // Stress: very long Bengali headline + big counts (spec §18)
        ("9-longbangla", st(mode: .approval,
                            headline: "সাপ্লায়ার পেমেন্ট অনুমোদন দরকার — রফিক ট্রেডার্সের বকেয়া বিল পরিশোধের জন্য",
                            subtitle: "রফিক ট্রেডার্স · ইনভয়েস #AR-2048 · আজকের মধ্যে দরকার",
                            tasks: 128, approvals: 47, orders: 999,
                            items: [approvalItem, ordersItem, tasksItem],
                            approvalTitle: "সাপ্লায়ার পেমেন্ট অনুমোদন — রফিক ট্রেডার্স বকেয়া",
                            counterparty: "রফিক ট্রেডার্স · ইনভয়েস #AR-2048", amount: "৳১২,৪৮,৫০০"), .approval),
    ]
}

@MainActor
func renderAll() {
    guard #available(iOS 16.1, *) else { return }
    let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    for (name, state, mode) in cases() {
        for (suffix, scheme) in [("dark", ColorScheme.dark), ("light", ColorScheme.light)] {
            let view = PulseLockScreenView(title: "ALMA ERP", state: state, mode: mode)
                .frame(width: 360)
                .environment(\.colorScheme, scheme)
            let r = ImageRenderer(content: view)
            r.scale = 3
            if let img = r.uiImage, let data = img.pngData() {
                try? data.write(to: dir.appendingPathComponent("\(name)-\(suffix).png"))
            }
        }
    }
    // Large Dynamic Type (spec §18)
    if let approval = cases().first(where: { $0.0 == "3-approval" }) {
        let view = PulseLockScreenView(title: "ALMA ERP", state: approval.1, mode: approval.2)
            .frame(width: 360)
            .environment(\.sizeCategory, .accessibilityLarge)
        let r = ImageRenderer(content: view)
        r.scale = 3
        if let img = r.uiImage, let data = img.pngData() {
            try? data.write(to: dir.appendingPathComponent("10-approval-xxxl.png"))
        }
    }
    print("PULSESNAP_DONE \(dir.path)")
}

@main
struct SnapApp: App {
    init() { renderAll() }
    var body: some Scene { WindowGroup { Text("snap") } }
}
