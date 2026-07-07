//
//  KeyboardDismiss.swift
//  ALMA ERP — app-wide "tap outside to dismiss the keyboard".
//
//  Owner bug (2026-07-06): once the keyboard came up it stayed until you left the
//  page — tapping empty space did nothing. SwiftUI's `.scrollDismissesKeyboard` only
//  reacts to a scroll DRAG, and numeric/phone pads have no return key, so there was
//  no way to put the keyboard away with a tap.
//
//  Fix: install ONE tap recogniser on the key window. It:
//    • fires on taps that land on empty space → resigns first responder (dismiss),
//    • ignores taps on a UITextField / UITextView / UIControl (delegate returns false)
//      so a field can still take focus and buttons/steppers keep working,
//    • uses cancelsTouchesInView = false so it never swallows the underlying tap.
//  It is removed again when the hosting view goes away (dismantleUIView).
//

import SwiftUI
import UIKit

/// Programmatic dismiss — also used by the keyboard "Done" toolbar button.
@MainActor
func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                    to: nil, from: nil, for: nil)
}

final class KeyboardDismissCoordinator: NSObject, UIGestureRecognizerDelegate {
    weak var recognizer: UITapGestureRecognizer?

    @objc func handleTap() { hideKeyboard() }

    // Let taps on inputs / controls through untouched — only bare-background taps dismiss.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let v = view {
            if v is UITextField || v is UITextView || v is UIControl { return false }
            view = v.superview
        }
        return true
    }

    func gestureRecognizer(_ g: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

private struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeCoordinator() -> KeyboardDismissCoordinator { KeyboardDismissCoordinator() }

    func makeUIView(context: Context) -> UIView {
        let probe = UIView()
        probe.isUserInteractionEnabled = false          // never grabs touches itself
        DispatchQueue.main.async {
            guard let window = probe.window, context.coordinator.recognizer == nil else { return }
            let tap = UITapGestureRecognizer(target: context.coordinator,
                                             action: #selector(KeyboardDismissCoordinator.handleTap))
            tap.cancelsTouchesInView = false
            tap.delegate = context.coordinator
            window.addGestureRecognizer(tap)
            context.coordinator.recognizer = tap
        }
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: KeyboardDismissCoordinator) {
        if let r = coordinator.recognizer {
            r.view?.removeGestureRecognizer(r)
            coordinator.recognizer = nil
        }
    }
}

extension View {
    /// Tap anywhere outside a text field to dismiss the keyboard — app-wide, without
    /// blocking buttons or stopping a field from taking focus.
    func dismissKeyboardOnTap() -> some View {
        background(KeyboardDismissInstaller().allowsHitTesting(false))
    }
}
