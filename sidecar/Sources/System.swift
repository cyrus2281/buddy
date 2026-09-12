import Foundation
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import ScreenCaptureKit

/// Permission state, reported rather than assumed. The UI shows live status and
/// re-detects after a grant; nothing in buddy is allowed to guess (PRD §8.6).
enum Permissions {

    /// `CGPreflightScreenCaptureAccess` is the only API that answers without
    /// side effects. `SCShareableContent` would prompt, which is not what a
    /// status poll should do.
    static func screenRecording() -> Bool { CGPreflightScreenCaptureAccess() }

    /// `prompt: false` for polling; `true` is what the Grant button calls.
    static func accessibility(prompt: Bool = false) -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    static func status() -> [String: Any] {
        ["screenRecording": screenRecording(), "accessibility": accessibility(prompt: false)]
    }
}

/// The T0 signal source: cheap enough to poll every 2 s, and the thing that
/// detects context switches.
enum Frontmost {

    static func snapshot() -> [String: Any] {
        let app = NSWorkspace.shared.frontmostApplication
        let pid = app?.processIdentifier ?? -1
        return [
            "bundleId": app?.bundleIdentifier ?? "",
            "appName": app?.localizedName ?? "",
            "pid": Int(pid),
            "windowTitle": windowTitle(pid: pid) ?? "",
            "idleSeconds": idleSeconds(),
            "secureInput": SecureInput.enabled(),
            "displayCount": NSScreen.screens.count,
        ]
    }

    /// Seconds since the last real human input. Reads the HID system state, so
    /// synthesized events buddy itself posts do not reset it.
    static func idleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .init(rawValue: ~0)!)
    }

    /// AX first — it gives the focused window, not just the frontmost one, and
    /// it is what M2's executor will target anyway. CGWindowList is the
    /// fallback when Accessibility has not been granted yet; it needs Screen
    /// Recording to return titles at all on macOS 10.15+.
    static func windowTitle(pid: pid_t) -> String? {
        if pid > 0, Permissions.accessibility() {
            let axApp = AXUIElementCreateApplication(pid)
            var window: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &window) == .success,
               let w = window {
                var title: CFTypeRef?
                // swiftlint:disable:next force_cast
                if AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success,
                   let t = title as? String, !t.isEmpty {
                    return t
                }
            }
        }
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let name = w[kCGWindowName as String] as? String, !name.isEmpty
            else { continue }
            return name
        }
        return nil
    }
}

/// When another process holds Secure Event Input, the OS silently swallows
/// synthesized keystrokes and the agent believes it typed. M2 turns this into a
/// real tool error; M1 needs it because T1 must skip those frames entirely.
enum SecureInput {
    static func enabled() -> Bool { IsSecureEventInputEnabled() }

    /// Best-effort attribution. There is no public API for "who holds it", so
    /// this reports the frontmost app as the likely holder and says so.
    static func detail() -> [String: Any] {
        let on = enabled()
        return ["enabled": on,
                "likelyHolder": on ? (NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown") : "",
                "attribution": "heuristic"]
    }
}
