import Foundation
import CoreGraphics
import AppKit
import Carbon.HIToolbox

/// CGEvent synthesis (PRD §6.4). The RPC surface, the action vocabulary, and the
/// tagging constant were fixed at M1; M2 fills in the switch body.
///
/// Coordinates arriving here are already **screen points in the CGEvent global
/// space** — the executor has divided the model's pixel coordinate by the
/// frame's scale factor and added the display origin (§6.2). Nothing in this
/// file knows about the model's coordinate space, which is the point: the
/// scaling bug can only exist in one place.
enum Input {

    /// Every synthesized event carries this in `.eventSourceUserData`, which is
    /// what lets §7.3's human-takeover kill switch tell a real keystroke from
    /// one of buddy's own.
    static let magic: Int64 = 0x62756464_79000001  // "budd" + 'y'

    /// The 17 members of `computer_toolset_20260801`, plus nothing else. An
    /// action outside this set is a protocol error, not something to interpret.
    static let actions: Set<String> = [
        "screenshot", "zoom",
        "left_click", "right_click", "middle_click", "double_click", "triple_click",
        "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up",
        "cursor_position", "scroll", "type", "key", "hold_key", "wait",
    ]

    /// `screenshot` and `zoom` are the two members that return an image. They
    /// are served from the capture path, not from here, so that one piece of
    /// code owns the scale factor that travels with every frame.
    static let handledByCapture: Set<String> = ["screenshot", "zoom"]

    static let keyboardActions: Set<String> = ["type", "key", "hold_key"]

    // MARK: - Dispatch

    static func perform(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard let action = params["action"]?.stringValue else {
            throw RPCError.invalidParams("input requires `action`")
        }
        guard actions.contains(action) else {
            throw RPCError.invalidParams("unknown action: \(action)")
        }
        guard !handledByCapture.contains(action) else {
            throw RPCError.invalidParams("input.\(action) is served by the capture path, not by input")
        }
        // Validate the parameters before the permission gates, so a malformed
        // request always reads as a protocol error rather than as whichever gate
        // happened to be closed. It also makes the parsers testable on a machine
        // with nothing granted.
        try precheck(action, params)

        // Keyboard delivery is a lie while another process holds Secure Event
        // Input: the OS swallows the keystrokes and the agent believes it typed.
        if keyboardActions.contains(action), SecureInput.enabled() {
            throw RPCError.internalError(
                "secure_event_input_held: Secure Event Input is held by "
                + "\(SecureInput.detail()["likelyHolder"] as? String ?? "another app")"
                + ". Keyboard input cannot be delivered.")
        }
        guard Permissions.accessibility() else {
            throw RPCError.internalError(
                "accessibility_not_granted: buddy cannot synthesize input without the "
                + "Accessibility permission.")
        }

        switch action {
        case "mouse_move":
            let p = try point(params)
            try move(to: p)
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "left_click", "right_click", "middle_click":
            let p = try point(params, orCurrent: true)
            let button: CGMouseButton = action == "right_click" ? .right : (action == "middle_click" ? .center : .left)
            try click(at: p, button: button, clicks: 1, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "double_click":
            let p = try point(params, orCurrent: true)
            try click(at: p, button: .left, clicks: 2, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "triple_click":
            let p = try point(params, orCurrent: true)
            try click(at: p, button: .left, clicks: 3, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "left_mouse_down":
            let p = try point(params, orCurrent: true)
            try mouse(.leftMouseDown, at: p, button: .left, clickState: 1, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "left_mouse_up":
            let p = try point(params, orCurrent: true)
            try mouse(.leftMouseUp, at: p, button: .left, clickState: 1, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y]]

        case "left_click_drag":
            let from = try point(params, key: "start_coordinate")
            let to = try point(params)
            try drag(from: from, to: to, flags: modifiers(params))
            return ["ok": true, "from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]]

        case "cursor_position":
            let p = currentPosition()
            return ["x": Int(p.x.rounded()), "y": Int(p.y.rounded())]

        case "scroll":
            let p = try point(params, orCurrent: true)
            guard let dir = params["scroll_direction"]?.stringValue else {
                throw RPCError.invalidParams("scroll requires `scroll_direction`")
            }
            let amount = params["scroll_amount"]?.intValue ?? 3
            try scroll(at: p, direction: dir, amount: amount, flags: modifiers(params))
            return ["ok": true, "at": ["x": p.x, "y": p.y], "direction": dir, "amount": amount]

        case "type":
            guard let text = params["text"]?.stringValue else {
                throw RPCError.invalidParams("type requires `text`")
            }
            let n = try typeText(text)
            return ["ok": true, "characters": n]

        case "key":
            guard let combo = params["text"]?.stringValue else {
                throw RPCError.invalidParams("key requires `text`")
            }
            let times = max(1, min(params["repeat"]?.intValue ?? 1, 100))
            for _ in 0..<times { try pressCombo(combo) }
            return ["ok": true, "key": combo, "repeat": times]

        case "hold_key":
            guard let combo = params["text"]?.stringValue else {
                throw RPCError.invalidParams("hold_key requires `text`")
            }
            let seconds = min(params["duration"]?.doubleValue ?? 1, 30)
            try holdCombo(combo, seconds: seconds)
            return ["ok": true, "key": combo, "duration": seconds]

        case "wait":
            let seconds = min(max(params["duration"]?.doubleValue ?? 1, 0), 30)
            Thread.sleep(forTimeInterval: seconds)
            return ["ok": true, "duration": seconds]

        default:
            // Unreachable: `actions` is checked above. Kept so adding a member
            // to the vocabulary without handling it fails loudly.
            throw RPCError.internalError("action \(action) is in the vocabulary but has no implementation")
        }
    }

    /// Parse everything the dispatch would parse, and throw the same errors,
    /// without touching the machine.
    private static func precheck(_ action: String, _ params: [String: JSONValue]) throws {
        switch action {
        case "mouse_move":
            _ = try point(params)
        case "left_click_drag":
            _ = try point(params, key: "start_coordinate")
            _ = try point(params)
        case "left_click", "right_click", "middle_click", "double_click", "triple_click",
             "left_mouse_down", "left_mouse_up":
            _ = try point(params, orCurrent: true)
        case "scroll":
            _ = try point(params, orCurrent: true)
            guard let dir = params["scroll_direction"]?.stringValue else {
                throw RPCError.invalidParams("scroll requires `scroll_direction`")
            }
            guard ["up", "down", "left", "right"].contains(dir.lowercased()) else {
                throw RPCError.invalidParams("scroll_direction must be up | down | left | right")
            }
        case "type":
            guard params["text"]?.stringValue != nil else {
                throw RPCError.invalidParams("type requires `text`")
            }
        case "key", "hold_key":
            guard let combo = params["text"]?.stringValue else {
                throw RPCError.invalidParams("\(action) requires `text`")
            }
            _ = try parseCombo(combo)
        default:
            break
        }
    }

    // MARK: - Event source

    /// One source for the whole process. `.hidSystemState` synthesizes as if
    /// from hardware, which is what apps that check the event source expect;
    /// every event sets its flags explicitly so it never inherits a modifier the
    /// user happens to be holding.
    private static let source: CGEventSource? = CGEventSource(stateID: .hidSystemState)

    private static func tag(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: magic)
    }

    private static func post(_ event: CGEvent) {
        tag(event)
        event.post(tap: .cghidEventTap)
    }

    // MARK: - Parameters

    private static func point(_ params: [String: JSONValue], key: String = "coordinate",
                              orCurrent: Bool = false) throws -> CGPoint {
        guard let raw = params[key] else {
            if orCurrent { return currentPosition() }
            throw RPCError.invalidParams("\(key) is required")
        }
        // The toolset sends [x, y]; tolerate {x, y} because a hand-written test
        // or a future schema revision is cheaper to accept than to debug.
        if let arr = raw.arrayValue, arr.count >= 2,
           let x = arr[0].doubleValue, let y = arr[1].doubleValue {
            return CGPoint(x: x, y: y)
        }
        if let o = raw.objectValue, let x = o["x"]?.doubleValue, let y = o["y"]?.doubleValue {
            return CGPoint(x: x, y: y)
        }
        throw RPCError.invalidParams("\(key) must be [x, y]")
    }

    /// Clicks and scrolls may carry modifier keys to hold, as `text` ("ctrl+shift")
    /// or as `hold_keys` (["ctrl", "shift"]).
    private static func modifiers(_ params: [String: JSONValue]) -> CGEventFlags {
        var tokens: [String] = []
        if let t = params["text"]?.stringValue, !t.isEmpty {
            tokens += t.split(whereSeparator: { $0 == "+" || $0 == " " }).map(String.init)
        }
        if let arr = params["hold_keys"]?.arrayValue {
            tokens += arr.compactMap { $0.stringValue }
        }
        var flags: CGEventFlags = []
        for t in tokens { flags.formUnion(modifierFlag(t) ?? []) }
        return flags
    }

    private static func modifierFlag(_ token: String) -> CGEventFlags? {
        switch token.lowercased() {
        case "ctrl", "control": return .maskControl
        case "alt", "option", "opt": return .maskAlternate
        case "shift": return .maskShift
        case "cmd", "command", "super", "meta", "win": return .maskCommand
        case "fn", "function": return .maskSecondaryFn
        default: return nil
        }
    }

    // MARK: - Mouse

    static func currentPosition() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private static func mouse(_ type: CGEventType, at p: CGPoint, button: CGMouseButton,
                              clickState: Int64, flags: CGEventFlags) throws {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: p, mouseButton: button) else {
            throw RPCError.internalError("could not create mouse event \(type.rawValue)")
        }
        e.setIntegerValueField(.mouseEventClickState, value: clickState)
        e.flags = flags
        post(e)
    }

    private static func move(to p: CGPoint, flags: CGEventFlags = []) throws {
        try mouse(.mouseMoved, at: p, button: .left, clickState: 0, flags: flags)
    }

    private static func click(at p: CGPoint, button: CGMouseButton, clicks: Int, flags: CGEventFlags) throws {
        let (down, up): (CGEventType, CGEventType) = {
            switch button {
            case .right: return (.rightMouseDown, .rightMouseUp)
            case .center: return (.otherMouseDown, .otherMouseUp)
            default: return (.leftMouseDown, .leftMouseUp)
            }
        }()
        // Move first: apps that track hover state (menus, tooltips, anything
        // with a :hover affordance) need the pointer to arrive before the press.
        try move(to: p, flags: flags)
        Thread.sleep(forTimeInterval: 0.012)
        for i in 1...clicks {
            try mouse(down, at: p, button: button, clickState: Int64(i), flags: flags)
            try mouse(up, at: p, button: button, clickState: Int64(i), flags: flags)
            if i < clicks { Thread.sleep(forTimeInterval: 0.04) }
        }
    }

    /// Dragged in steps. A single down-move-up is ignored by most list and
    /// canvas views, which only start a drag after the pointer has actually
    /// travelled while held.
    private static func drag(from: CGPoint, to: CGPoint, flags: CGEventFlags) throws {
        try move(to: from, flags: flags)
        Thread.sleep(forTimeInterval: 0.02)
        try mouse(.leftMouseDown, at: from, button: .left, clickState: 1, flags: flags)
        Thread.sleep(forTimeInterval: 0.03)

        let steps = 18
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            try mouse(.leftMouseDragged, at: p, button: .left, clickState: 1, flags: flags)
            Thread.sleep(forTimeInterval: 0.008)
        }
        Thread.sleep(forTimeInterval: 0.03)
        try mouse(.leftMouseUp, at: to, button: .left, clickState: 1, flags: flags)
    }

    private static func scroll(at p: CGPoint, direction: String, amount: Int, flags: CGEventFlags) throws {
        try move(to: p, flags: flags)
        // One "click" of a physical wheel is ~3 lines. The toolset's `amount` is
        // in wheel clicks, so this keeps a scroll of 3 feeling like three notches
        // rather than three lines.
        let ticks = max(1, min(amount, 50)) * 3
        var dy = 0, dx = 0
        switch direction.lowercased() {
        case "up": dy = ticks
        case "down": dy = -ticks
        case "left": dx = ticks
        case "right": dx = -ticks
        default: throw RPCError.invalidParams("scroll_direction must be up | down | left | right")
        }
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line,
                              wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else {
            throw RPCError.internalError("could not create scroll event")
        }
        e.location = p
        e.flags = flags
        post(e)
    }

    // MARK: - Keyboard

    /// `CGEventKeyboardSetUnicodeString` rather than a keycode table: it handles
    /// non-ASCII, emoji, and any keyboard layout, none of which a US-ANSI
    /// keycode map does (PRD §6.4).
    @discardableResult
    private static func typeText(_ text: String) throws -> Int {
        guard !text.isEmpty else { return 0 }
        // A newline typed as a unicode string is dropped by many text views, and
        // in a message composer it is a send, not a line break. Split on it and
        // press the real Return key so the behaviour is the one the app expects
        // — and so the executor's guardrail sees a Return it can classify.
        let lines = text.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            if !line.isEmpty { try typeChunked(line) }
            if i < lines.count - 1 { try pressCombo("Return") }
        }
        return text.count
    }

    private static func typeChunked(_ text: String) throws {
        // UTF-16 units, in modest chunks: the API takes a buffer, but very long
        // strings arrive garbled or reordered in some apps.
        let units = Array(text.utf16)
        let chunk = 16
        var i = 0
        while i < units.count {
            let slice = Array(units[i..<min(i + chunk, units.count)])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw RPCError.internalError("could not create keyboard event")
            }
            down.flags = []
            up.flags = []
            down.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: slice)
            up.keyboardSetUnicodeString(stringLength: slice.count, unicodeString: slice)
            post(down)
            post(up)
            i += chunk
            Thread.sleep(forTimeInterval: 0.012)
        }
    }

    /// "cmd+shift+4", "Return", "ctrl+a". Modifiers are posted as real modifier
    /// key events around the keystroke rather than only as flags, because some
    /// apps (Electron ones especially) read the modifier key state rather than
    /// the event's flag mask.
    private static func pressCombo(_ combo: String) throws {
        let (flags, keyCode, shiftedByLayout) = try parseCombo(combo)
        var effective = flags
        if shiftedByLayout { effective.formUnion(.maskShift) }

        for mod in modifierKeyCodes(effective) { try postModifier(mod, down: true, flags: effective) }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw RPCError.internalError("could not create keyboard event")
        }
        down.flags = effective
        up.flags = effective
        post(down)
        Thread.sleep(forTimeInterval: 0.012)
        post(up)
        for mod in modifierKeyCodes(effective).reversed() { try postModifier(mod, down: false, flags: []) }
    }

    private static func holdCombo(_ combo: String, seconds: Double) throws {
        let (flags, keyCode, shiftedByLayout) = try parseCombo(combo)
        var effective = flags
        if shiftedByLayout { effective.formUnion(.maskShift) }

        for mod in modifierKeyCodes(effective) { try postModifier(mod, down: true, flags: effective) }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            throw RPCError.internalError("could not create keyboard event")
        }
        down.flags = effective
        up.flags = effective
        // A held key repeats; `.keyboardEventAutorepeat` is what tells the
        // receiving app these are repeats rather than distinct presses.
        post(down)
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            if let r = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) {
                r.flags = effective
                r.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
                post(r)
            }
        }
        post(up)
        for mod in modifierKeyCodes(effective).reversed() { try postModifier(mod, down: false, flags: []) }
    }

    private static func postModifier(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else {
            throw RPCError.internalError("could not create modifier event")
        }
        e.type = .flagsChanged
        e.flags = flags
        post(e)
        Thread.sleep(forTimeInterval: 0.006)
    }

    private static func modifierKeyCodes(_ flags: CGEventFlags) -> [CGKeyCode] {
        var out: [CGKeyCode] = []
        if flags.contains(.maskControl) { out.append(CGKeyCode(kVK_Control)) }
        if flags.contains(.maskAlternate) { out.append(CGKeyCode(kVK_Option)) }
        if flags.contains(.maskShift) { out.append(CGKeyCode(kVK_Shift)) }
        if flags.contains(.maskCommand) { out.append(CGKeyCode(kVK_Command)) }
        return out
    }

    /// Returns the modifier mask, the virtual keycode, and whether the layout
    /// needs Shift to produce the character (e.g. `?` is shift-`/`).
    private static func parseCombo(_ combo: String) throws -> (CGEventFlags, CGKeyCode, Bool) {
        let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { throw RPCError.invalidParams("empty key combination") }

        // The last token is the key; everything before it is a modifier. This is
        // the toolset's convention and it makes "shift+shift" impossible to
        // write by accident.
        var flags: CGEventFlags = []
        for part in parts.dropLast() {
            guard let f = modifierFlag(part) else {
                throw RPCError.invalidParams("not a modifier: \(part) (in \(combo))")
            }
            flags.formUnion(f)
        }
        let token = parts[parts.count - 1]
        guard let (code, needsShift) = keyCode(for: token) else {
            throw RPCError.invalidParams("unknown key: \(token)")
        }
        return (flags, code, needsShift)
    }

    /// X11 keysym-ish names (what the toolset emits) mapped onto macOS virtual
    /// keycodes. Only the keys a `key` action can name live here; ordinary text
    /// goes through `type`, which needs no table at all.
    private static let named: [String: CGKeyCode] = [
        "return": CGKeyCode(kVK_Return), "enter": CGKeyCode(kVK_Return),
        "kp_enter": CGKeyCode(kVK_ANSI_KeypadEnter),
        "tab": CGKeyCode(kVK_Tab), "space": CGKeyCode(kVK_Space),
        "backspace": CGKeyCode(kVK_Delete), "delete": CGKeyCode(kVK_Delete),
        "forwarddelete": CGKeyCode(kVK_ForwardDelete), "kp_delete": CGKeyCode(kVK_ForwardDelete),
        "escape": CGKeyCode(kVK_Escape), "esc": CGKeyCode(kVK_Escape),
        "up": CGKeyCode(kVK_UpArrow), "down": CGKeyCode(kVK_DownArrow),
        "left": CGKeyCode(kVK_LeftArrow), "right": CGKeyCode(kVK_RightArrow),
        "home": CGKeyCode(kVK_Home), "end": CGKeyCode(kVK_End),
        "page_up": CGKeyCode(kVK_PageUp), "pageup": CGKeyCode(kVK_PageUp), "prior": CGKeyCode(kVK_PageUp),
        "page_down": CGKeyCode(kVK_PageDown), "pagedown": CGKeyCode(kVK_PageDown), "next": CGKeyCode(kVK_PageDown),
        "f1": CGKeyCode(kVK_F1), "f2": CGKeyCode(kVK_F2), "f3": CGKeyCode(kVK_F3), "f4": CGKeyCode(kVK_F4),
        "f5": CGKeyCode(kVK_F5), "f6": CGKeyCode(kVK_F6), "f7": CGKeyCode(kVK_F7), "f8": CGKeyCode(kVK_F8),
        "f9": CGKeyCode(kVK_F9), "f10": CGKeyCode(kVK_F10), "f11": CGKeyCode(kVK_F11), "f12": CGKeyCode(kVK_F12),
        // F13-F20 exist on full-size Apple keyboards and the toolset can name
        // them. F19 in particular has no default binding anywhere in macOS,
        // which makes it the one keystroke that is safe to synthesize in a test.
        "f13": CGKeyCode(kVK_F13), "f14": CGKeyCode(kVK_F14), "f15": CGKeyCode(kVK_F15),
        "f16": CGKeyCode(kVK_F16), "f17": CGKeyCode(kVK_F17), "f18": CGKeyCode(kVK_F18),
        "f19": CGKeyCode(kVK_F19), "f20": CGKeyCode(kVK_F20),
    ]

    /// Unshifted characters on a US-ANSI layout. `type` is the right tool for
    /// text, so this only has to cover what appears in a shortcut.
    private static let ansi: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
        "m": 46, ".": 47, "`": 50,
    ]

    /// Characters that are Shift + something else on a US-ANSI layout.
    private static let ansiShifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
        "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
        "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]

    private static func keyCode(for token: String) -> (CGKeyCode, Bool)? {
        if let code = named[token.lowercased()] { return (code, false) }
        guard token.count == 1, let ch = token.lowercased().first else { return nil }
        if let code = ansi[ch] { return (code, false) }
        if let base = ansiShifted[token.first!], let code = ansi[base] { return (code, true) }
        return nil
    }
}
