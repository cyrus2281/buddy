import Foundation
import AppKit
import ApplicationServices

/// Accessibility tree reads. M2's `describe_focused_window` tool returns this
/// alongside every screenshot so the model targets a named element instead of
/// guessing a pixel — the largest single reliability win available (PRD §6.3).
///
/// M1 uses only `focusedSummary`, to skip frames while a secure text field has
/// focus. The full walk is here because the guardrail enforcement point in §7.2
/// reads the same tree and it would be built twice otherwise.
enum AXTree {

    static let maxDepth = 12
    static let maxNodes = 1500

    struct Options {
        var pid: pid_t?
        var depth: Int = maxDepth
        var maxNodes: Int = AXTree.maxNodes
    }

    static func tree(_ opts: Options) throws -> [String: Any] {
        guard Permissions.accessibility() else {
            throw RPCError.internalError("accessibility_not_granted")
        }
        let pid = opts.pid ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        guard pid > 0 else { throw RPCError.invalidParams("no frontmost application") }

        let axApp = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        let root: AXUIElement
        if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
           let w = windowRef {
            root = unsafeDowncast(w as AnyObject, to: AXUIElement.self)
        } else {
            root = axApp
        }

        var budget = opts.maxNodes
        let node = walk(root, depth: min(opts.depth, maxDepth), budget: &budget)
        let app = NSRunningApplication(processIdentifier: pid)
        return [
            "pid": Int(pid),
            "bundleId": app?.bundleIdentifier ?? "",
            "appName": app?.localizedName ?? "",
            "truncated": budget <= 0,
            "focused": focusedSummary(pid: pid) as Any,
            "tree": node,
        ]
    }

    /// Cheap, shallow, and the only AX call on M1's hot path: T1 runs it before
    /// every capture so a password field never reaches a PNG.
    static func focusedSummary(pid: pid_t? = nil) -> [String: Any]? {
        guard Permissions.accessibility() else { return nil }
        let target = pid ?? NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        guard target > 0 else { return nil }
        let axApp = AXUIElementCreateApplication(target)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let f = focused else { return nil }
        let el = unsafeDowncast(f as AnyObject, to: AXUIElement.self)
        let role = string(el, kAXRoleAttribute) ?? ""
        let subrole = string(el, kAXSubroleAttribute) ?? ""
        return [
            "role": role,
            "subrole": subrole,
            "title": string(el, kAXTitleAttribute) ?? "",
            // Most apps report a password field as AXTextField/AXSecureTextField;
            // some report the subrole as the role. Match either, as literals —
            // the SDK exposes no constant for the role spelling.
            "isSecureTextField": role == "AXSecureTextField" || subrole == "AXSecureTextField",
        ]
    }

    /// True when the user is typing into a password field. T1 drops the frame
    /// rather than capturing and filtering it later — there is no version of
    /// that PNG we want on disk.
    static func focusedFieldIsSecure() -> Bool {
        (focusedSummary()?["isSecureTextField"] as? Bool) ?? false
    }

    private static func walk(_ el: AXUIElement, depth: Int, budget: inout Int) -> [String: Any] {
        budget -= 1
        var node: [String: Any] = [:]
        if let r = string(el, kAXRoleAttribute) { node["role"] = r }
        if let s = string(el, kAXSubroleAttribute), !s.isEmpty { node["subrole"] = s }
        if let t = string(el, kAXTitleAttribute), !t.isEmpty { node["title"] = t }
        if let d = string(el, kAXDescriptionAttribute), !d.isEmpty { node["description"] = d }
        if let v = string(el, kAXValueAttribute), !v.isEmpty { node["value"] = String(v.prefix(400)) }
        if let e = bool(el, kAXEnabledAttribute), e == false { node["enabled"] = false }
        if let f = frame(el) {
            node["frame"] = ["x": f.origin.x, "y": f.origin.y, "w": f.size.width, "h": f.size.height]
        }

        guard depth > 0, budget > 0 else { return node }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let arr = childrenRef as? [AXUIElement], !arr.isEmpty else { return node }

        var kids: [[String: Any]] = []
        for child in arr {
            if budget <= 0 { node["truncated"] = true; break }
            kids.append(walk(child, depth: depth - 1, budget: &budget))
        }
        if !kids.isEmpty { node["children"] = kids }
        return node
    }

    private static func string(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private static func bool(_ el: AXUIElement, _ attr: String) -> Bool? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return (v as? NSNumber)?.boolValue
    }

    /// AX hands back position and size as opaque AXValues; they have to be
    /// unpacked one at a time.
    private static func frame(_ el: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let p = posRef, let s = sizeRef else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(unsafeDowncast(p as AnyObject, to: AXValue.self), .cgPoint, &origin)
        AXValueGetValue(unsafeDowncast(s as AnyObject, to: AXValue.self), .cgSize, &size)
        return CGRect(origin: origin, size: size)
    }
}
