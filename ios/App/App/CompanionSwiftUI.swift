//
//  CompanionSwiftUI.swift
//  App
//
//  SwiftUI-era chrome for the P3 "Phone Companion" — WITHOUT touching its core.
//
//  AlmaCompanionViewController (AlmaCompanion.swift) is the working heart: the
//  agent-driven WKWebView, pairing flow, poll loop, STOP bar, lockdown + final-
//  submit guards. It is embedded here UNCHANGED via UIViewControllerRepresentable;
//  this file only wraps it in a native SwiftUI frame:
//
//    ┌──────────────────────────────────┐
//    │  CompanionHeaderCard (SwiftUI)   │  glassy themed strip: dot + title +
//    │  "Phone Companion" + Bangla hint │  Bangla hint. STATIC by design — the
//    ├──────────────────────────────────┤  VC exposes no observable state and we
//    │  AlmaCompanionViewController     │  refuse to hack into it (see notes at
//    │  (untouched: its own status bar, │  the bottom for the tiny hooks it
//    │   STOP button, agent web view)   │  would need for a live header).
//    └──────────────────────────────────┘
//
//  .claudeTopFade is deliberately NOT applied: the fade only makes sense over a
//  ScrollView owned by this screen, and here ALL scrolling lives inside the
//  embedded VC's WKWebView. An overlay fade would just blur/dim the top of the
//  agent's web surface (and the VC's own status bar) without any scroll-edge
//  semantics — so the header card is the visual separator instead.
//
//  Theme tokens mirror AlmaTheme in SpikeNativeShell.swift (coral #E07A5F,
//  violet #a78bfa, light bg #F2F0F8, dark bg #0b0a12). They are duplicated here
//  (private) so this file stays standalone-compilable; keep in sync if AlmaTheme
//  ever changes.
//

import SwiftUI
import UIKit
import WebKit

// MARK: - Local theme tokens (mirror of AlmaTheme — keep in sync)

@available(iOS 17.0, *)
private enum CompanionTheme {
    /// #E07A5F — ALMA coral accent.
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)
    /// #a78bfa — ALMA violet accent.
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.980)
    /// #F2F0F8 — light root background.
    static let lightBg = Color(red: 0.949, green: 0.941, blue: 0.972)
    /// #0b0a12 — dark root background.
    static let darkBg = Color(red: 0.043, green: 0.039, blue: 0.070)

    static func rootBg(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkBg : lightBg
    }
    static func title(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(white: 0.97) : Color(red: 0.13, green: 0.11, blue: 0.16)
    }
}

// MARK: - Representable (embeds the untouched VC)

/// Thin bridge: creates the companion VC once and never touches it again.
/// Built on a factory closure so previews/tests can inject a stub VC and so this
/// file typechecks without dragging the whole app target in.
@available(iOS 17.0, *)
private struct CompanionVCBox: UIViewControllerRepresentable {
    let makeCompanionVC: () -> UIViewController

    func makeUIViewController(context: Context) -> UIViewController {
        makeCompanionVC()
    }

    /// Deliberately empty — the VC runs its own lifecycle (pairing prompt on
    /// viewDidAppear, poll stop on viewWillDisappear). SwiftUI must not poke it.
    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}

// MARK: - Header card

/// Premium static strip above the companion surface. Static on purpose: the VC
/// keeps its own live status bar (Bangla status + STOP) just below, fully visible.
@available(iOS 17.0, *)
private struct CompanionHeaderCard: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 12) {
            // Connection dot — coral core with a soft violet halo. Static (no
            // live state exposed by the VC); the REAL live dot is the VC's own.
            ZStack {
                Circle()
                    .fill(CompanionTheme.violet.opacity(0.28))
                    .frame(width: 20, height: 20)
                Circle()
                    .fill(CompanionTheme.coral)
                    .frame(width: 10, height: 10)
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("Phone Companion")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(CompanionTheme.title(scheme))
                Text("এজেন্ট এই ফোনের ব্রাউজার চালাতে পারবে")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
            }

            Spacer(minLength: 0)

            Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(CompanionTheme.violet)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            CompanionTheme.violet.opacity(scheme == .dark ? 0.45 : 0.30),
                            CompanionTheme.coral.opacity(scheme == .dark ? 0.30 : 0.20),
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.10), radius: 10, y: 4)
    }
}

// MARK: - The screen

/// SwiftUI shell for the Phone Companion. The embedded VC is untouched and owns
/// all behaviour (pairing, polling, STOP, the agent web view). No ScrollView of
/// our own ⇒ no .claudeTopFade (see file header).
@available(iOS 17.0, *)
struct CompanionScreen: View {
    @Environment(\.colorScheme) private var scheme

    private let makeCompanionVC: () -> UIViewController

    /// Production entry point — the companion VC shares cookies/logins with the
    /// rest of the app through the default website data store.
    init() {
        self.makeCompanionVC = { AlmaCompanionViewController() }
    }

    /// Injection entry point (previews / tests): supply any stand-in VC so the
    /// pairing alert + network poll loop never fire outside the real app.
    init(makeCompanionVC: @escaping () -> UIViewController) {
        self.makeCompanionVC = makeCompanionVC
    }

    var body: some View {
        VStack(spacing: 10) {
            CompanionHeaderCard()
                .padding(.horizontal, 12)
                .padding(.top, 8)

            CompanionVCBox(makeCompanionVC: makeCompanionVC)
                .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
        }
        .background(CompanionTheme.rootBg(scheme).ignoresSafeArea())
    }
}

// MARK: - Preview (stub VC — no pairing alert, no network)

@available(iOS 17.0, *)
#Preview("Companion chrome — stub") {
    CompanionScreen(makeCompanionVC: {
        // Plain stand-in so the preview canvas never spins up WebKit/pairing.
        let vc = UIViewController()
        vc.view.backgroundColor = UIColor(red: 0.086, green: 0.078, blue: 0.122, alpha: 1)
        let label = UILabel()
        label.text = "AlmaCompanionViewController lives here"
        label.textColor = UIColor(white: 1, alpha: 0.6)
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: vc.view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: vc.view.centerYAnchor),
        ])
        return vc
    })
}

//
//  ── Tiny hooks AlmaCompanion.swift would need for a LIVE header (not done here;
//     main session decides) ────────────────────────────────────────────────────
//  1. A 3-case state enum + callback:  `var onStateChange: ((CompanionState) -> Void)?`
//     fired inside the existing `setStatus(text:color:)` (one line: derive
//     .connecting/.connected/.stopped from the colour it already picks).
//  2. Or lighter: `NotificationCenter.default.post(name: .almaCompanionStatus,
//     object: nil, userInfo: ["text": text])` in the same method — the SwiftUI
//     header observes it with .onReceive; zero API surface on the VC.
//  Either is ~4 lines in setStatus and breaks nothing.
//
