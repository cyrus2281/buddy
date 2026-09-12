import Foundation
import CoreGraphics

/// CGEvent synthesis. **Stubbed in M1** — the RPC surface, the action
/// vocabulary, and the tagging constant are fixed here so M2 fills in a switch
/// body and changes nothing above it (PRD §6.4).
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

    static func perform(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard let action = params["action"]?.stringValue else {
            throw RPCError.invalidParams("input requires `action`")
        }
        guard actions.contains(action) else {
            throw RPCError.invalidParams("unknown action: \(action)")
        }
        // Keyboard delivery is a lie while another process holds Secure Event
        // Input, so M2's error path is wired now even though the actions are not.
        if ["type", "key", "hold_key"].contains(action), SecureInput.enabled() {
            throw RPCError.internalError(
                "secure_event_input_held: Secure Event Input is held by "
                + "\(SecureInput.detail()["likelyHolder"] as? String ?? "another app")"
                + ". Keyboard input cannot be delivered.")
        }
        throw RPCError.internalError("not_implemented_in_m1: input.\(action) lands in M2")
    }
}
