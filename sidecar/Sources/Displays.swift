import Foundation
import ScreenCaptureKit
import AppKit
import CoreGraphics

/// Display enumeration, separated only because it needs the async
/// `SCShareableContent` API and `main.swift` is already the dispatch table.
enum SCShareableContentBox {
    static func displays() async throws -> [[String: Any]] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return content.displays.map { d in
            let screen = NSScreen.screens.first {
                ($0.deviceDescription[.init("NSScreenNumber")] as? NSNumber)?.uint32Value == d.displayID
            }
            let backing = screen?.backingScaleFactor ?? 2.0
            let bounds = CGDisplayBounds(d.displayID)
            var out: [String: Any] = [
                "id": Int(d.displayID),
                "width": d.width,          // logical points
                "height": d.height,
                "originX": bounds.origin.x,
                "originY": bounds.origin.y,
                "backingScaleFactor": backing,
                "modelScale": Capture.modelScale(width: Double(d.width), height: Double(d.height)),
                "isMain": screen == NSScreen.main,
                "builtIn": CGDisplayIsBuiltin(d.displayID) != 0,
                "notch": NSNull(),
                "menuBarHeight": 0,
            ]
            if let s = screen {
                // The menu bar is the strip between the visible frame and the
                // top of the screen (AppKit's y axis points up).
                out["menuBarHeight"] = max(0, s.frame.maxY - s.visibleFrame.maxY)
                // The camera housing: the gap between the two auxiliary areas
                // either side of it, as tall as the top safe-area inset. x in
                // AppKit's screen space is the same axis as CG's global x.
                if s.safeAreaInsets.top > 0,
                   let left = s.auxiliaryTopLeftArea, let right = s.auxiliaryTopRightArea {
                    out["notch"] = ["x": left.maxX, "width": right.minX - left.maxX, "height": s.safeAreaInsets.top]
                }
            }
            return out
        }
    }
}
