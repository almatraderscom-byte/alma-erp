import UIKit
import SwiftUI

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ a: UIApplication,
                     didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        if #available(iOS 17.0, *) {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: "/tmp/islandprobe/fixture.json"))
                var state = try JSONDecoder().decode(PulseActivityAttributes.ContentState.self, from: data)
                // ── A) expanded-island bottom pages: budget ≤ 92pt ──
                for (file, m, raw) in [("bottom-approval.png", PulseMode.approval, "approval"),
                                        ("bottom-orders.png", PulseMode.orders, "orders"),
                                        ("bottom-tasks.png", PulseMode.overview, "overview")] {
                    state.mode = raw
                    let v = PulseExpandedBody(state: state, mode: m)
                        .frame(width: 340)
                        .background(Color.black)
                    let r = ImageRenderer(content: v); r.scale = 3
                    if let img = r.uiImage {
                        print("MEASURE bottom \(raw) height=\(Int(img.size.height)) pt (budget 92)")
                        try? img.pngData()?.write(to: URL(fileURLWithPath: "/tmp/islandprobe/\(file)"))
                    }
                }
                // ── B) lock-screen card: hard cap 160pt ──
                for (file, m, raw) in [("lock-approval.png", PulseMode.approval, "approval"),
                                        ("lock-orders.png", PulseMode.orders, "orders")] {
                    state.mode = raw
                    let v = PulseLockScreenView(title: "ALMA", state: state, mode: m)
                        .frame(width: 372)
                    let r = ImageRenderer(content: v); r.scale = 3
                    if let img = r.uiImage {
                        print("MEASURE lock \(raw) height=\(Int(img.size.height)) pt (cap 160)")
                        try? img.pngData()?.write(to: URL(fileURLWithPath: "/tmp/islandprobe/\(file)"))
                    }
                }
                print("MEASURE-DONE")
            } catch { print("PROBE-FAILED \(error)") }
        }
        exit(0)
    }
}
