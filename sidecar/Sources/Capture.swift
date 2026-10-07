import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit
import CoreImage

/// ScreenCaptureKit capture, downscaled from native Retina pixels to logical
/// points so model coordinates map 1:1 onto CGEvent points with no scale factor
/// in the executor (PRD §6.2).
enum Capture {

    /// Opus 5's image ceiling. Beyond either bound the frame is scaled down
    /// further and `scale` stops being 1.0 — which the executor must then
    /// divide by. Silently wrong coordinates are the worst failure mode in this
    /// product, so the factor travels with every frame.
    static let maxLongEdge: Double = 2576
    static let maxPixels: Double = 3_750_000

    static func modelScale(width: Double, height: Double) -> Double {
        min(1.0, maxLongEdge / max(width, height), (maxPixels / (width * height)).squareRoot())
    }

    struct Result {
        let pngPath: String
        let bytes: Int
        let pixelWidth: Int      // native Retina pixels captured
        let pixelHeight: Int
        let width: Int           // what actually landed in the PNG
        let height: Int
        let logicalWidth: Int    // the display's point size
        let logicalHeight: Int
        let scale: Double        // modelCoord / scale == screenPoint
        let phash: String
        let displayID: UInt32
        /// The display's top-left in the global CGEvent coordinate space. Zero
        /// on a single-display Mac; on a second display it is the offset the
        /// executor must add, and omitting it puts every click on the wrong
        /// screen (PRD §6.2).
        let originX: Double
        let originY: Double

        var dictionary: [String: Any] {
            ["path": pngPath, "bytes": bytes,
             "pixelWidth": pixelWidth, "pixelHeight": pixelHeight,
             "width": width, "height": height,
             "logicalWidth": logicalWidth, "logicalHeight": logicalHeight,
             "scale": scale, "phash": phash, "displayId": Int(displayID),
             "originX": originX, "originY": originY]
        }
    }

    enum Target {
        case display(UInt32?)
        case window(UInt32)
        case region(CGRect)
    }

    /// buddy's own windows — the HUD, Home, the island in the notch, the ghost
    /// cursor overlay — are left out of every display capture unless asked
    /// for. They all belong to the Electron main process, which is this
    /// process's parent. A model reading a screenshot with buddy's own status
    /// pill in it is reading about itself; an observation of the Home window is
    /// buddy remembering buddy; and the ghost cursor exists to show the
    /// *person* where the next click lands, not to be clicked.
    static func ownApps(_ content: SCShareableContent) -> [SCRunningApplication] {
        let parent = getppid()
        return content.applications.filter { $0.processID == parent }
    }

    static func capture(target: Target, to path: String, maxWidth: Int?, maxHeight: Int?,
                        includeSelf: Bool = false) async throws -> Result {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let hidden = includeSelf ? [] : ownApps(content)

        let filter: SCContentFilter
        let display: SCDisplay
        var cropRect: CGRect? = nil
        /// Set for a window capture: its frame in global points, which is both
        /// the size the picture should be and the origin its coordinates are
        /// relative to. Without it a window was rendered at the display's size,
        /// stretched — a picture of a 600-point window 1728 points wide.
        var windowFrame: CGRect? = nil

        switch target {
        case .display(let wanted):
            guard let d = wanted.flatMap({ id in content.displays.first { $0.displayID == id } })
                    ?? content.displays.first else {
                throw RPCError.invalidParams("no such display")
            }
            display = d
            filter = SCContentFilter(display: d, excludingApplications: hidden, exceptingWindows: [])

        case .window(let windowID):
            guard let w = content.windows.first(where: { $0.windowID == windowID }) else {
                throw RPCError.invalidParams("no such window: \(windowID)")
            }
            // The display the window is mostly on, for the backing scale.
            let mid = CGPoint(x: w.frame.midX, y: w.frame.midY)
            guard let d = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(mid) })
                    ?? content.displays.first else { throw RPCError.internalError("no displays") }
            display = d
            filter = SCContentFilter(desktopIndependentWindow: w)
            windowFrame = w.frame

        case .region(let rect):
            guard let d = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(CGPoint(x: rect.midX, y: rect.midY)) })
                    ?? content.displays.first else { throw RPCError.internalError("no displays") }
            display = d
            filter = SCContentFilter(display: d, excludingApplications: hidden, exceptingWindows: [])
            cropRect = rect
        }

        // Logical point size of the display, and the backing scale that gets us
        // from points to the native pixels ScreenCaptureKit hands back.
        let screen = NSScreen.screens.first { screen in
            (screen.deviceDescription[.init("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID
        }
        let backing = screen?.backingScaleFactor ?? 2.0
        let logicalW = windowFrame.map { Int($0.width.rounded()) } ?? display.width
        let logicalH = windowFrame.map { Int($0.height.rounded()) } ?? display.height

        let cfg = SCStreamConfiguration()
        cfg.width = Int(Double(logicalW) * backing)
        cfg.height = Int(Double(logicalH) * backing)
        cfg.capturesAudio = false
        cfg.showsCursor = true
        cfg.scalesToFit = true
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        if let r = cropRect {
            // `sourceRect` is in the display's own space; the region arrives in
            // the global one. Identical on the display at the origin — which
            // is why a zoom on any other display used to crop the wrong place.
            let o = CGDisplayBounds(display.displayID).origin
            cfg.sourceRect = r.offsetBy(dx: -o.x, dy: -o.y)
            cfg.width = Int(r.width * backing)
            cfg.height = Int(r.height * backing)
        }

        let native = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)

        // Target size: logical points, then the §6.2 guard, then any caller cap
        // (T2 asks for 1366x768 to stay under Haiku's 1.15 MP ceiling).
        var targetW = Double(cropRect.map { Int($0.width) } ?? logicalW)
        var targetH = Double(cropRect.map { Int($0.height) } ?? logicalH)
        let guardScale = modelScale(width: targetW, height: targetH)
        targetW *= guardScale
        targetH *= guardScale
        var scale = guardScale
        if let mw = maxWidth, let mh = maxHeight, mw > 0, mh > 0 {
            let extra = min(1.0, Double(mw) / targetW, Double(mh) / targetH)
            targetW *= extra; targetH *= extra; scale *= extra
        }

        let outW = max(1, Int(targetW.rounded()))
        let outH = max(1, Int(targetH.rounded()))
        guard let resized = resize(native, to: CGSize(width: outW, height: outH)) else {
            throw RPCError.internalError("resize failed")
        }

        let hash = PerceptualHash.compute(resized)

        let rep = NSBitmapImageRep(cgImage: resized)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw RPCError.internalError("png encode failed")
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try png.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)

        // CGDisplayBounds is in exactly the coordinate space CGEvent uses, so
        // it is the right source for the offset rather than NSScreen's flipped
        // frame.
        let bounds = CGDisplayBounds(display.displayID)
        return Result(pngPath: path, bytes: png.count,
                      pixelWidth: native.width, pixelHeight: native.height,
                      width: outW, height: outH,
                      logicalWidth: logicalW, logicalHeight: logicalH,
                      scale: scale, phash: hash, displayID: display.displayID,
                      originX: Double(cropRect?.origin.x ?? windowFrame?.origin.x ?? bounds.origin.x),
                      originY: Double(cropRect?.origin.y ?? windowFrame?.origin.y ?? bounds.origin.y))
    }

    private static func resize(_ image: CGImage, to size: CGSize) -> CGImage? {
        if image.width == Int(size.width) && image.height == Int(size.height) { return image }
        let w = Int(size.width), h = Int(size.height)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }
}

/// 64-bit DCT perceptual hash. Computed here rather than in the main process
/// because the sidecar writes the PNG straight to the vault — sending the bytes
/// over stdio only to hash them would be the whole frame's cost for 8 bytes.
enum PerceptualHash {
    private static let n = 32   // DCT input
    private static let k = 8    // low-frequency block kept

    static func compute(_ image: CGImage) -> String {
        var gray = [Double](repeating: 0, count: n * n)
        var pixels = [UInt8](repeating: 0, count: n * n)
        guard let ctx = CGContext(data: &pixels, width: n, height: n, bitsPerComponent: 8,
                                  bytesPerRow: n, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return String(repeating: "0", count: 16) }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: n, height: n))
        for i in 0..<(n * n) { gray[i] = Double(pixels[i]) }

        // Separable 2-D DCT-II; only the top-left k×k block is ever read, but
        // the rows must be fully transformed to get there.
        var rows = [Double](repeating: 0, count: n * n)
        for y in 0..<n {
            for u in 0..<n {
                var sum = 0.0
                for x in 0..<n { sum += gray[y * n + x] * cosTable[x][u] }
                rows[y * n + u] = sum * (u == 0 ? invSqrt2 : 1)
            }
        }
        var block = [Double]()
        block.reserveCapacity(k * k)
        for v in 0..<k {
            for u in 0..<k {
                var sum = 0.0
                for y in 0..<n { sum += rows[y * n + u] * cosTable[y][v] }
                block.append(sum * (v == 0 ? invSqrt2 : 1))
            }
        }

        // The DC term dominates and carries brightness, not structure. Median
        // over the remaining 63 coefficients is the standard threshold.
        let ac = Array(block.dropFirst()).sorted()
        let median = ac[ac.count / 2]

        var bits: UInt64 = 0
        for (i, c) in block.enumerated() where c > median { bits |= (1 << UInt64(i)) }
        return String(format: "%016llx", bits)
    }

    static func distance(_ a: String, _ b: String) -> Int {
        guard let x = UInt64(a, radix: 16), let y = UInt64(b, radix: 16) else { return 64 }
        return (x ^ y).nonzeroBitCount
    }

    private static let invSqrt2 = 1.0 / 2.0.squareRoot()
    private static let cosTable: [[Double]] = (0..<n).map { x in
        (0..<n).map { u in cos(Double(2 * x + 1) * Double(u) * Double.pi / Double(2 * n)) }
    }
}
