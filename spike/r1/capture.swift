// R1 spike: does TCC attribute a sidecar binary's ScreenCaptureKit capture
// to the parent .app bundle? Captures one frame, writes a PNG, reports
// whether the pixels are all black.
import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("ERROR: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : NSTemporaryDirectory() + "r1-capture.png"

let sem = DispatchSemaphore(value: 0)

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                          onScreenWindowsOnly: true)
        guard let display = content.displays.first else { fail("no displays") }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = display.width
        cfg.height = display.height
        cfg.capturesAudio = false
        cfg.showsCursor = false

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter,
                                                              configuration: cfg)

        // Is the frame actually black? Sample a grid rather than every pixel.
        let ctxW = 64, ctxH = 64
        var buf = [UInt8](repeating: 0, count: ctxW * ctxH * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &buf, width: ctxW, height: ctxH,
                                  bitsPerComponent: 8, bytesPerRow: ctxW * 4,
                                  space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { fail("could not make sampling context") }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: ctxW, height: ctxH))

        var maxLuma = 0, nonBlack = 0
        for i in stride(from: 0, to: buf.count, by: 4) {
            let l = Int(buf[i]) + Int(buf[i+1]) + Int(buf[i+2])
            if l > maxLuma { maxLuma = l }
            if l > 12 { nonBlack += 1 }
        }

        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            fail("png encode failed")
        }
        try png.write(to: URL(fileURLWithPath: outPath))

        let result: [String: Any] = [
            "path": outPath,
            "width": image.width,
            "height": image.height,
            "bytes": png.count,
            "maxLuma": maxLuma,
            "nonBlackSamples": nonBlack,
            "totalSamples": ctxW * ctxH,
            "verdict": nonBlack > 64 ? "NOT_BLACK" : "BLACK",
        ]
        let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(json)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        sem.signal()
    } catch {
        fail("capture threw: \(error)")
    }
}

sem.wait()
