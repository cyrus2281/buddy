import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

/// Hands-off: acting on an app through its accessibility tree instead of the
/// mouse and keyboard the person is using.
///
/// Everything in `Input.swift` drives the *shared* controls — it moves the real
/// pointer and types into whatever has focus, which is why a normal run means
/// handing the machine over. These calls do not. `AXPress` on a button, a value
/// set on a text field, a key event posted to one process: each reaches the app
/// it names without moving the cursor or changing which app is in front. That
/// is what lets buddy work in Slack while the person keeps typing in their
/// editor.
///
/// Two things this file cannot promise, and so measures instead:
///
///   - **Focus.** An app is free to activate itself in response to an action
///     (a link that opens a browser, a button that raises a sheet). Every act
///     records the frontmost app before and after, and hands focus back when it
///     was taken, and says so either way — rather than claiming a property the
///     OS does not guarantee.
///   - **That the app honoured it.** A value set on a React-controlled field can
///     be accepted by AX and ignored by the page. `set_value` reads the value
///     back and reports whether it stuck.
enum Hands {

    // MARK: - Element references

    /// `e12` in the tree the model reads is element 12 here.
    ///
    /// Ids are never reused: every tree reading assigns fresh ones, and the last
    /// few readings stay resolvable. Resetting to 1 on each reading would make a
    /// batch like "press e12, look, press e14" silently press whatever the
    /// *second* reading happened to number 14 — a different element, picked by
    /// an id the model read off the first.
    enum Registry {
        private static var next = 1
        private static var current: [Int: AXUIElement] = [:]
        private static var older: [[Int: AXUIElement]] = []
        static let keepReadings = 4

        static func beginReading() {
            if !current.isEmpty {
                older.append(current)
                if older.count > keepReadings - 1 { older.removeFirst(older.count - (keepReadings - 1)) }
            }
            current = [:]
        }

        static func register(_ el: AXUIElement) -> Int {
            let id = next
            next += 1
            current[id] = el
            return id
        }

        static func lookup(_ id: Int) -> AXUIElement? {
            if let el = current[id] { return el }
            for reading in older.reversed() { if let el = reading[id] { return el } }
            return nil
        }
    }

    private static func element(_ params: [String: JSONValue]) throws -> (Int, AXUIElement) {
        guard let ref = params["ref"]?.intValue else { throw RPCError.invalidParams("`ref` is required") }
        guard let el = Registry.lookup(ref) else {
            throw RPCError.invalidParams(
                "stale_element: e\(ref) is not from a recent reading of the window. Look at the window again.")
        }
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &role) == .invalidUIElement {
            throw RPCError.internalError(
                "element_gone: e\(ref) no longer exists — the window changed under it. Look again.")
        }
        return (ref, el)
    }

    // MARK: - Apps and windows

    /// The app a hands-off call names, by bundle id or pid. Only running apps:
    /// launching one is `open`, which is its own classified action.
    static func runningApp(_ params: [String: JSONValue]) throws -> NSRunningApplication {
        if let pid = params["pid"]?.intValue, pid > 0,
           let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
            return app
        }
        if let bid = params["bundleId"]?.stringValue, !bid.isEmpty {
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bid)
            // A helper sharing the bundle id has no windows; prefer the one that does.
            if let app = apps.first(where: { $0.activationPolicy == .regular }) ?? apps.first { return app }
            throw RPCError.invalidParams("app_not_running: \(bid) is not running. Open it first.")
        }
        throw RPCError.invalidParams("`bundleId` or `pid` is required")
    }

    /// The window a reading starts from: the app's focused window, its main
    /// window, then its first — or the one whose title contains `titleHint`.
    /// An app in the background still has a focused window; it is simply not
    /// the key window of the session.
    static func window(of pid: pid_t, titleHint: String?) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        let all = (copy(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        if let hint = titleHint?.lowercased(), !hint.isEmpty {
            if let w = all.first(where: { (string($0, kAXTitleAttribute) ?? "").lowercased().contains(hint) }) {
                return w
            }
        }
        for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if let w = copy(app, attr) { return unsafeDowncast(w as AnyObject, to: AXUIElement.self) }
        }
        return all.first
    }

    /// Private, stable since 10.x, and used by every window manager on the
    /// platform: the CGWindowID behind an AX window. Without it the window a
    /// reading describes and the window a capture photographs are matched by
    /// bounds and title, which two identical document windows defeat.
    @_silgen_name("_AXUIElementGetWindow")
    private static func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError

    static func windowID(_ win: AXUIElement, pid: pid_t) -> CGWindowID? {
        var wid: CGWindowID = 0
        if _AXUIElementGetWindow(win, &wid) == .success, wid != 0 { return wid }
        // Fallback: match on owner and bounds.
        guard let f = frame(win),
              let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }
        for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid {
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  abs((b["X"] ?? -1) - f.origin.x) < 2, abs((b["Y"] ?? -1) - f.origin.y) < 2,
                  abs((b["Width"] ?? -1) - f.width) < 2, abs((b["Height"] ?? -1) - f.height) < 2
            else { continue }
            return w[kCGWindowNumber as String] as? CGWindowID
        }
        return nil
    }

    /// Every regular app and its windows — what a hands-off run is told is open
    /// before it looks at anything, and the raw material for the workspace
    /// snapshot.
    static func windows(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else { throw RPCError.internalError("accessibility_not_granted") }
        let apps: [NSRunningApplication]
        if params["bundleId"] != nil || params["pid"] != nil {
            apps = [try runningApp(params)]
        } else {
            apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let out: [[String: Any]] = apps.map { app in
            let pid = app.processIdentifier
            let axApp = AXUIElementCreateApplication(pid)
            let focused = copy(axApp, kAXFocusedWindowAttribute).map { unsafeDowncast($0 as AnyObject, to: AXUIElement.self) }
            let wins = (copy(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? []
            // The page a browser is on, for the focused window only: reading a
            // URL means walking a window's tree for its web area, and doing
            // that for every window of every browser would turn one cheap call
            // into dozens of deep ones.
            let page = TargetInfo.browsers.contains(app.bundleIdentifier ?? "") ? TargetInfo.pageURL(pid: pid) : nil
            return [
                "pid": Int(pid),
                "bundleId": app.bundleIdentifier ?? "",
                "appName": app.localizedName ?? "",
                "active": pid == front,
                "hidden": app.isHidden,
                "bundlePath": app.bundleURL?.path ?? "",
                "windows": wins.prefix(30).map { w -> [String: Any] in
                    var o: [String: Any] = [
                        "title": string(w, kAXTitleAttribute) ?? "",
                        "minimized": bool(w, kAXMinimizedAttribute) ?? false,
                        "fullscreen": bool(w, "AXFullScreen") ?? false,
                        "main": bool(w, kAXMainAttribute) ?? false,
                        "focused": focused.map { CFEqual($0, w) } ?? false,
                        "subrole": string(w, kAXSubroleAttribute) ?? "",
                    ]
                    if let f = frame(w) { o["frame"] = ["x": f.origin.x, "y": f.origin.y, "w": f.width, "h": f.height] }
                    if let id = windowID(w, pid: pid) { o["windowId"] = Int(id) }
                    if let doc = string(w, kAXDocumentAttribute), !doc.isEmpty { o["document"] = doc }
                    if let page, (o["focused"] as? Bool) == true { o["url"] = page }
                    return o
                },
            ]
        }
        return ["apps": out]
    }

    // MARK: - Reading a background window

    /// What `look` needs from buddyd in one round trip: the app, the window it
    /// will photograph, and the tree with element ids.
    static func look(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else { throw RPCError.internalError("accessibility_not_granted") }
        let app = try runningApp(params)
        let pid = app.processIdentifier
        guard let win = window(of: pid, titleHint: params["windowTitle"]?.stringValue) else {
            throw RPCError.internalError(
                "no_window: \(app.localizedName ?? "the app") has no window to look at. Open one first.")
        }
        var opts = AXTree.Options()
        opts.depth = params["depth"]?.intValue ?? AXTree.maxDepth
        opts.maxNodes = params["maxNodes"]?.intValue ?? 900
        opts.register = true
        Registry.beginReading()
        var budget = opts.maxNodes
        let tree = AXTree.walk(win, depth: min(opts.depth, AXTree.maxDepth), budget: &budget, register: true)
        var out: [String: Any] = [
            "pid": Int(pid),
            "bundleId": app.bundleIdentifier ?? "",
            "appName": app.localizedName ?? "",
            "active": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            "windowTitle": string(win, kAXTitleAttribute) ?? "",
            "minimized": bool(win, kAXMinimizedAttribute) ?? false,
            "truncated": budget <= 0,
            "tree": tree,
        ]
        if let id = windowID(win, pid: pid) { out["windowId"] = Int(id) }
        if let f = frame(win) { out["frame"] = ["x": f.origin.x, "y": f.origin.y, "w": f.width, "h": f.height] }
        return out
    }

    // MARK: - Acting

    /// The AX action each verb maps to. `press` falls back up the parent chain,
    /// because the element a reading names is often the label inside a button
    /// rather than the button.
    private static let verbActions: [String: String] = [
        "press": kAXPressAction,
        "confirm": kAXConfirmAction,
        "cancel": kAXCancelAction,
        "increment": kAXIncrementAction,
        "decrement": kAXDecrementAction,
        "show_menu": kAXShowMenuAction,
        "raise": kAXRaiseAction,
        "scroll_to_visible": "AXScrollToVisible",
    ]

    static let verbs: Set<String> = Set(verbActions.keys).union(["focus", "select", "set_value"])

    static func act(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else {
            throw RPCError.internalError("accessibility_not_granted: hands-off actions need Accessibility.")
        }
        let verb = params["action"]?.stringValue ?? "press"
        guard verbs.contains(verb) else {
            throw RPCError.invalidParams("unknown action \(verb); one of \(verbs.sorted().joined(separator: ", "))")
        }
        if verb == "set_value", params["value"]?.stringValue == nil {
            throw RPCError.invalidParams("set_value requires `value`")
        }
        let (ref, el) = try element(params)
        let frontBefore = NSWorkspace.shared.frontmostApplication
        let pointerBefore = Input.currentPosition()
        var out: [String: Any] = ["ok": true, "ref": ref, "action": verb]

        switch verb {
        case "set_value":
            let value = params["value"]!.stringValue!
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable)
            guard settable.boolValue else {
                throw RPCError.internalError(
                    "not_settable: e\(ref) (\(string(el, kAXRoleAttribute) ?? "?")) does not take a value. "
                    + "Focus it and use send_keys, or pick the text field itself.")
            }
            let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
            guard err == .success else {
                throw RPCError.internalError("set_value_failed: the app refused the value (AXError \(err.rawValue)).")
            }
            // Read back: accepted by AX and honoured by the app are different
            // things, and a web view can do the first without the second.
            usleep(60_000)
            let now = string(el, kAXValueAttribute) ?? ""
            out["value"] = String(now.prefix(400))
            out["verified"] = now == value

        case "focus":
            let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard err == .success else {
                throw RPCError.internalError("focus_failed: e\(ref) cannot take focus (AXError \(err.rawValue)).")
            }

        case "select":
            let err = AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            if err != .success { try perform(el, kAXPressAction, ref: ref) }

        default:
            try perform(el, verbActions[verb]!, ref: ref)
        }

        // Give the app a beat to react, then account for what it did to the
        // session the person is using.
        usleep(150_000)
        let frontAfter = NSWorkspace.shared.frontmostApplication
        let stole = frontBefore != nil && frontAfter?.processIdentifier != frontBefore?.processIdentifier
        var restored = false
        if stole, params["restoreFocus"]?.boolValue != false, let prev = frontBefore {
            restored = prev.activate(options: [])
        }
        let p = Input.currentPosition()
        out["stoleFocus"] = stole
        out["tookFocusTo"] = stole ? (frontAfter?.localizedName ?? "") : ""
        out["restoredFocus"] = restored
        out["pointerMoved"] = hypot(p.x - pointerBefore.x, p.y - pointerBefore.y) > 1
        out["role"] = string(el, kAXRoleAttribute) ?? ""
        out["title"] = TargetInfo.name(of: el)
        return out
    }

    /// Perform an action, climbing to the nearest ancestor that supports it.
    private static func perform(_ el: AXUIElement, _ action: String, ref: Int) throws {
        var node: AXUIElement? = el
        for _ in 0..<4 {
            guard let n = node else { break }
            var names: CFArray?
            if AXUIElementCopyActionNames(n, &names) == .success,
               let list = names as? [String], list.contains(action) {
                let err = AXUIElementPerformAction(n, action as CFString)
                if err == .success { return }
                throw RPCError.internalError("action_failed: \(action) on e\(ref) returned AXError \(err.rawValue).")
            }
            node = copy(n, kAXParentAttribute).map { unsafeDowncast($0 as AnyObject, to: AXUIElement.self) }
        }
        var names: CFArray?
        AXUIElementCopyActionNames(el, &names)
        let supported = (names as? [String])?.joined(separator: ", ") ?? "none"
        throw RPCError.internalError(
            "unsupported: e\(ref) does not support \(action) (it supports: \(supported.isEmpty ? "none" : supported)).")
    }

    // MARK: - Guardrail facts for an element

    /// `target_info`, for an element or an app rather than a screen point. The
    /// guardrail asks the same question either way — what is this about to
    /// touch? — and for hands-off the answer is the *named* app, which is often
    /// not the frontmost one. Classifying against the frontmost app would check
    /// the allowlist against the editor the person is typing in while buddy
    /// presses Send in Slack.
    static func target(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else { throw RPCError.internalError("accessibility_not_granted") }
        var pid: pid_t = -1
        var el: AXUIElement? = nil
        if params["ref"] != nil {
            let (_, e) = try element(params)
            el = e
            AXUIElementGetPid(e, &pid)
        } else {
            pid = try runningApp(params).processIdentifier
            // A screen point, hit-tested by *that* app rather than system-wide.
            // The cua backend acts on windows that are behind others, and the
            // system-wide hit test answers with whatever is on top — the
            // person's editor, not the Send button buddy is about to press.
            if let x = params["x"]?.doubleValue, let y = params["y"]?.doubleValue {
                var ref: AXUIElement?
                if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(x), Float(y), &ref) == .success {
                    el = ref
                }
            }
        }
        let app = NSRunningApplication(processIdentifier: pid)
        let bundleId = app?.bundleIdentifier ?? ""
        var windowTitle = ""
        if let e = el, let w = copy(e, kAXWindowAttribute) {
            windowTitle = string(unsafeDowncast(w as AnyObject, to: AXUIElement.self), kAXTitleAttribute) ?? ""
        } else if pid > 0, let w = window(of: pid, titleHint: nil) {
            windowTitle = string(w, kAXTitleAttribute) ?? ""
        }
        var out: [String: Any] = [
            "bundleId": bundleId,
            "appName": app?.localizedName ?? "",
            "pid": Int(pid),
            "windowTitle": windowTitle,
            "secureInput": SecureInput.enabled(),
            "focused": AXTree.focusedSummary(pid: pid) as Any,
            "url": NSNull(),
            "element": el.map { TargetInfo.nameable($0) } ?? NSNull(),
        ]
        if TargetInfo.browsers.contains(bundleId), let url = TargetInfo.pageURL(pid: pid) { out["url"] = url }
        return out
    }

    // MARK: - Keys to one app

    /// Keystrokes delivered to one process with `CGEventPostToPid`, so they
    /// reach that app's focused field without passing through whatever the
    /// person has in front. Same parser, same Unicode path and same tag as
    /// `Input` — only the destination differs.
    static func keys(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard Permissions.accessibility() else { throw RPCError.internalError("accessibility_not_granted") }
        let app = try runningApp(params)
        let key = params["key"]?.stringValue
        let text = params["text"]?.stringValue
        guard (key != nil) != (text != nil) else {
            throw RPCError.invalidParams("send exactly one of `key` or `text`")
        }
        let frontBefore = NSWorkspace.shared.frontmostApplication
        let r = try Input.toProcess(app.processIdentifier) {
            if let k = key {
                return try Input.perform(["action": .string("key"), "text": .string(k)])
            }
            return try Input.perform(["action": .string("type"), "text": .string(text!)])
        }
        let frontAfter = NSWorkspace.shared.frontmostApplication
        var out = r
        out["stoleFocus"] = frontAfter?.processIdentifier != frontBefore?.processIdentifier
        out["appName"] = app.localizedName ?? ""
        return out
    }

    // MARK: - Opening without taking the screen

    /// Launch an app, or open a URL or file in one, without activating it. The
    /// reply comes from the completion handler, because the launch is async and
    /// the next look needs the window to exist.
    static func open(_ params: [String: JSONValue], reply: @escaping (Result<[String: Any], RPCError>) -> Void) {
        guard let bid = params["bundleId"]?.stringValue, !bid.isEmpty else {
            reply(.failure(.invalidParams("`bundleId` is required"))); return
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) else {
            reply(.failure(.invalidParams("not_installed: no app with bundle id \(bid)"))); return
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = params["activate"]?.boolValue ?? false
        cfg.addsToRecentItems = false
        let done: (NSRunningApplication?, Error?) -> Void = { app, err in
            if let err {
                reply(.failure(.internalError("open_failed: \(err.localizedDescription)")))
                return
            }
            reply(.success(["ok": true, "pid": Int(app?.processIdentifier ?? -1),
                            "appName": app?.localizedName ?? "", "bundleId": bid]))
        }
        if let target = params["url"]?.stringValue, !target.isEmpty {
            let url = target.hasPrefix("/") ? URL(fileURLWithPath: target) : URL(string: target)
            guard let url else { reply(.failure(.invalidParams("not a URL: \(target)"))); return }
            NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: cfg, completionHandler: done)
        } else {
            NSWorkspace.shared.openApplication(at: appURL, configuration: cfg, completionHandler: done)
        }
    }

    // MARK: - AX helpers

    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = copy(el, attr) else { return nil }
        if let s = v as? String { return s }
        if let u = v as? NSURL { return u.absoluteString }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool? {
        (copy(el, attr) as? NSNumber)?.boolValue
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = copy(el, kAXPositionAttribute), let s = copy(el, kAXSizeAttribute) else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(unsafeDowncast(p as AnyObject, to: AXValue.self), .cgPoint, &origin)
        AXValueGetValue(unsafeDowncast(s as AnyObject, to: AXValue.self), .cgSize, &size)
        return CGRect(origin: origin, size: size)
    }
}
