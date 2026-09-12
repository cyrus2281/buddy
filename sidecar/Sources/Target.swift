import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

/// Two things the M2 guardrail needs that nothing in M1 provided.
///
/// **`TargetInfo`** answers, in one round trip, the question the executor asks
/// immediately before dispatching a `CGEvent`: *what am I about to touch?* PRD
/// §7.2 ranks the AX tree as the most trustworthy signal, so this reads the
/// element under the pointer through the app's own hit-testing rather than
/// guessing from a tree walk, and reads the page URL from the web area rather
/// than from whatever is typed in the address bar.
///
/// **`InputMonitor`** is §7.3's third kill switch. A listen-only event tap sees
/// every keystroke and click in the session, including buddy's own — which is
/// why §6.4 tags every synthesized event with `Input.magic`. Filtering on that
/// tag is the whole reason the constant exists.
enum TargetInfo {

    /// Bundle IDs whose focused window has a web area worth reading a URL from.
    static let browsers: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview",
        "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta",
        "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser",
        "org.mozilla.firefox", "com.vivaldi.Vivaldi", "ru.keepcoder.Telegram.browser",
        "com.operasoftware.Opera", "com.apple.WebKit.WebContent",
    ]

    static func snapshot(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else {
            throw RPCError.internalError("accessibility_not_granted")
        }
        let app = NSWorkspace.shared.frontmostApplication
        let pid = app?.processIdentifier ?? -1
        let bundleId = app?.bundleIdentifier ?? ""

        var out: [String: Any] = [
            "bundleId": bundleId,
            "appName": app?.localizedName ?? "",
            "pid": Int(pid),
            "windowTitle": Frontmost.windowTitle(pid: pid) ?? "",
            "secureInput": SecureInput.enabled(),
            "focused": AXTree.focusedSummary(pid: pid) as Any,
            "url": NSNull(),
            "element": NSNull(),
        ]

        if browsers.contains(bundleId), let url = pageURL(pid: pid) {
            out["url"] = url
        }
        if let x = params["x"]?.doubleValue, let y = params["y"]?.doubleValue {
            out["element"] = element(at: CGPoint(x: x, y: y)) ?? NSNull()
        }
        return out
    }

    /// The element the click would land on, via the system-wide hit test. This
    /// is the app answering "what is here", not buddy inferring it from frames,
    /// so it is right even for custom-drawn and overlapping views.
    static func element(at p: CGPoint) -> [String: Any]? {
        let system = AXUIElementCreateSystemWide()
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &ref) == .success,
              let el = ref else { return nil }

        var node = describe(el)
        // A button's title often lives on the element, but AppKit and web
        // toolbars alike hand back the inner text or image and hang the title on
        // the parent. Walk up until something is nameable, so
        // `/^(send|post|…)/i` sees "Send" rather than "".
        if (node["title"] as? String ?? "").isEmpty,
           (node["description"] as? String ?? "").isEmpty,
           let parent = attr(el, kAXParentAttribute) {
            let up = describe(unsafeDowncast(parent as AnyObject, to: AXUIElement.self))
            node["parent"] = up
            if (node["role"] as? String ?? "") != "AXButton", (up["role"] as? String ?? "") == "AXButton" {
                node["title"] = up["title"] ?? ""
                node["role"] = up["role"] ?? ""
            }
        }
        return node
    }

    private static func describe(_ el: AXUIElement) -> [String: Any] {
        let role = string(el, kAXRoleAttribute) ?? ""
        let subrole = string(el, kAXSubroleAttribute) ?? ""
        var node: [String: Any] = [
            "role": role,
            "subrole": subrole,
            "title": string(el, kAXTitleAttribute) ?? "",
            "description": string(el, kAXDescriptionAttribute) ?? "",
            "value": String((string(el, kAXValueAttribute) ?? "").prefix(400)),
            "help": string(el, kAXHelpAttribute) ?? "",
            // Some apps put the accessible name only on the label, which AX
            // exposes as AXTitleUIElement rather than as a title.
            "isSecureTextField": role == "AXSecureTextField" || subrole == "AXSecureTextField",
        ]
        if let enabled = bool(el, kAXEnabledAttribute) { node["enabled"] = enabled }
        if let f = frame(el) {
            node["frame"] = ["x": f.origin.x, "y": f.origin.y, "w": f.size.width, "h": f.size.height]
        }
        return node
    }

    /// The web area's own `AXURL`, not the address bar's text: the address bar
    /// shows what the user is halfway through typing, and a domain allowlist
    /// must be checked against the page that is actually loaded.
    static func pageURL(pid: pid_t) -> String? {
        let axApp = AXUIElementCreateApplication(pid)
        guard let win = attr(axApp, kAXFocusedWindowAttribute) else { return nil }
        let root = unsafeDowncast(win as AnyObject, to: AXUIElement.self)

        var budget = 400
        if let url = findWebAreaURL(root, budget: &budget) { return url }

        // Firefox and some Electron browsers do not expose AXURL on the web
        // area. The address bar is the fallback, and it is explicitly the weaker
        // signal of the two.
        budget = 400
        return findURLField(root, budget: &budget)
    }

    private static func findWebAreaURL(_ el: AXUIElement, budget: inout Int) -> String? {
        if budget <= 0 { return nil }
        budget -= 1
        if string(el, kAXRoleAttribute) == "AXWebArea" {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(el, "AXURL" as CFString, &v) == .success {
                if let u = v as? NSURL { return u.absoluteString }
                if let s = v as? String { return s }
            }
        }
        for child in children(el) {
            if let found = findWebAreaURL(child, budget: &budget) { return found }
        }
        return nil
    }

    private static func findURLField(_ el: AXUIElement, budget: inout Int) -> String? {
        if budget <= 0 { return nil }
        budget -= 1
        if string(el, kAXSubroleAttribute) == "AXURLField" || string(el, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" {
            let v = string(el, kAXValueAttribute) ?? ""
            if !v.isEmpty { return v }
        }
        for child in children(el) {
            if let found = findURLField(child, budget: &budget) { return found }
        }
        return nil
    }

    private static func children(_ el: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref) == .success,
              let arr = ref as? [AXUIElement] else { return [] }
        return arr
    }

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
        return v
    }

    private static func string(_ el: AXUIElement, _ name: String) -> String? {
        guard let v = attr(el, name) else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private static func bool(_ el: AXUIElement, _ name: String) -> Bool? {
        (attr(el, name) as? NSNumber)?.boolValue
    }

    private static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(unsafeDowncast(p as AnyObject, to: AXValue.self), .cgPoint, &origin)
        AXValueGetValue(unsafeDowncast(s as AnyObject, to: AXValue.self), .cgSize, &size)
        return CGRect(origin: origin, size: size)
    }
}

/// §7.3 kill switch 3 — human takeover.
///
/// A listen-only tap: it observes and never drops an event, so a wedged buddy
/// cannot also wedge the user's keyboard. Every event buddy synthesizes carries
/// `Input.magic` in `.eventSourceUserData`, so the filter that separates "the
/// user grabbed the wheel" from "buddy is driving" is one integer comparison
/// and not a heuristic.
enum InputMonitor {

    private static var tap: CFMachPort?
    private static var runLoopSource: CFRunLoopSource?
    private(set) static var watching = false
    /// Ignore events for a moment after starting, so the Return that confirmed
    /// the run in the HUD is not read as the user taking over from it.
    private static var armedAt: TimeInterval = 0
    private static let armDelay: TimeInterval = 0.6

    static let mask: CGEventMask =
        (1 << CGEventType.keyDown.rawValue) |
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.rightMouseDown.rawValue) |
        (1 << CGEventType.otherMouseDown.rawValue) |
        (1 << CGEventType.scrollWheel.rawValue)

    static func start() throws -> [String: Any] {
        if watching { return ["watching": true, "alreadyRunning": true] }
        guard Permissions.accessibility() else {
            throw RPCError.internalError("accessibility_not_granted: the human-takeover kill switch needs an event tap")
        }
        let callback: CGEventTapCallBack = { _, type, event, _ in
            InputMonitor.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                        place: .headInsertEventTap,
                                        options: .listenOnly,
                                        eventsOfInterest: mask,
                                        callback: callback,
                                        userInfo: nil) else {
            throw RPCError.internalError("could not create the event tap")
        }
        tap = t
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        armedAt = Date().timeIntervalSince1970
        watching = true
        Out.log("info", "input monitor started")
        return ["watching": true]
    }

    static func stop() -> [String: Any] {
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let s = runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        tap = nil
        runLoopSource = nil
        watching = false
        return ["watching": false]
    }

    private static func handle(type: CGEventType, event: CGEvent) {
        // The system disables a tap that takes too long in its callback. This
        // one does almost nothing, but re-enabling is free insurance against a
        // kill switch that quietly stopped working.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            Out.log("warn", "event tap was disabled, re-enabled")
            return
        }
        guard watching else { return }
        if event.getIntegerValueField(.eventSourceUserData) == Input.magic { return }  // our own
        if Date().timeIntervalSince1970 - armedAt < armDelay { return }

        watching = false  // one shot: the run is over, and repeats would be noise
        let kind: String = type == .keyDown ? "key" : (type == .scrollWheel ? "scroll" : "click")
        Out.log("warn", "human input during ACTING", ["kind": kind])
        Out.write(["jsonrpc": "2.0", "method": "human_input",
                   "params": ["kind": kind, "t": Date().timeIntervalSince1970]])
    }
}
