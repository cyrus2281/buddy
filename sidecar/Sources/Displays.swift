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
            return [
                "id": Int(d.displayID),
                "width": d.width,          // logical points
                "height": d.height,
                "originX": bounds.origin.x,
                "originY": bounds.origin.y,
                "backingScaleFactor": backing,
                "modelScale": Capture.modelScale(width: Double(d.width), height: Double(d.height)),
                "isMain": screen == NSScreen.main,
            ]
        }
    }
}
