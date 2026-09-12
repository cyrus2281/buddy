import Foundation
import AppKit

/// buddyd — buddy's macOS sidecar.
///
/// Speaks line-delimited JSON-RPC 2.0 on stdio. Requests are read on a
/// background thread and dispatched concurrently; the run loop stays on the main
/// thread because ScreenCaptureKit and AX both want it.

let BUDDYD_VERSION = "0.1.0"

func handle(_ req: RPCRequest) {
    switch req.method {

    case "ping":
        Out.result(id: req.id, ["pong": true, "version": BUDDYD_VERSION, "pid": Int(getpid())])

    case "permissions":
        Out.result(id: req.id, Permissions.status())

    case "request_permission":
        // Screen Recording can be requested in-process; Accessibility only via
        // the system prompt, and neither can be granted from here. The UI polls
        // `permissions` afterwards rather than trusting a return value.
        switch req.params["kind"]?.stringValue ?? "" {
        case "screenRecording":
            Out.result(id: req.id, ["requested": true, "granted": Permissions.requestScreenRecording()])
        case "accessibility":
            Out.result(id: req.id, ["requested": true, "granted": Permissions.accessibility(prompt: true)])
        default:
            Out.error(id: req.id, .invalidParams("kind must be screenRecording | accessibility"))
        }

    case "frontmost":
        Out.result(id: req.id, Frontmost.snapshot())

    case "secure_input":
        Out.result(id: req.id, SecureInput.detail())

    case "ax_tree":
        do {
            var opts = AXTree.Options()
            if let pid = req.params["pid"]?.intValue, pid > 0 { opts.pid = pid_t(pid) }
            if let d = req.params["depth"]?.intValue { opts.depth = d }
            if let n = req.params["maxNodes"]?.intValue { opts.maxNodes = n }
            Out.result(id: req.id, try AXTree.tree(opts))
        } catch let e as RPCError { Out.error(id: req.id, e) }
        catch { Out.error(id: req.id, .internalError(String(describing: error))) }

    case "focused_element":
        Out.result(id: req.id, ["focused": AXTree.focusedSummary() as Any,
                                "isSecureTextField": AXTree.focusedFieldIsSecure()])

    case "input":
        do { Out.result(id: req.id, try Input.perform(req.params)) }
        catch let e as RPCError { Out.error(id: req.id, e) }
        catch { Out.error(id: req.id, .internalError(String(describing: error))) }

    case "target_info":
        // The one call the M2 guardrail makes immediately before dispatching a
        // CGEvent: frontmost app, focused element, page URL, and the element
        // under the pointer, in a single round trip (PRD §7.2).
        do { Out.result(id: req.id, try TargetInfo.snapshot(req.params)) }
        catch let e as RPCError { Out.error(id: req.id, e) }
        catch { Out.error(id: req.id, .internalError(String(describing: error))) }

    case "watch_input":
        // §7.3 kill switch 3. Buddy's own events carry Input.magic and are
        // filtered; anything else fires a `human_input` notification.
        do { Out.result(id: req.id, try InputMonitor.start()) }
        catch let e as RPCError { Out.error(id: req.id, e) }
        catch { Out.error(id: req.id, .internalError(String(describing: error))) }

    case "unwatch_input":
        Out.result(id: req.id, InputMonitor.stop())

    case "capture":
        guard let path = req.params["path"]?.stringValue else {
            Out.error(id: req.id, .invalidParams("capture requires `path`")); return
        }
        let target: Capture.Target
        switch req.params["target"]?.stringValue ?? "display" {
        case "display":
            target = .display(req.params["displayId"]?.intValue.map(UInt32.init))
        case "window":
            guard let wid = req.params["windowId"]?.intValue else {
                Out.error(id: req.id, .invalidParams("target=window requires `windowId`")); return
            }
            target = .window(UInt32(wid))
        case "region":
            guard let r = req.params["region"]?.objectValue,
                  let x = r["x"]?.doubleValue, let y = r["y"]?.doubleValue,
                  let w = r["w"]?.doubleValue, let h = r["h"]?.doubleValue else {
                Out.error(id: req.id, .invalidParams("target=region requires region {x,y,w,h}")); return
            }
            target = .region(CGRect(x: x, y: y, width: w, height: h))
        default:
            Out.error(id: req.id, .invalidParams("target must be display | window | region")); return
        }
        let maxW = req.params["maxWidth"]?.intValue
        let maxH = req.params["maxHeight"]?.intValue
        let id = req.id
        Task {
            do {
                let r = try await Capture.capture(target: target, to: path, maxWidth: maxW, maxHeight: maxH)
                Out.result(id: id, r.dictionary)
            } catch let e as RPCError {
                Out.error(id: id, e)
            } catch {
                Out.error(id: id, .internalError(String(describing: error)))
            }
        }

    case "displays":
        Task {
            do {
                let content = try await SCShareableContentBox.displays()
                Out.result(id: req.id, ["displays": content])
            } catch {
                Out.error(id: req.id, .internalError(String(describing: error)))
            }
        }

    case "shutdown":
        Out.result(id: req.id, ["ok": true])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { exit(0) }

    default:
        Out.error(id: req.id, .methodNotFound("unknown method: \(req.method)"))
    }
}

func parse(_ line: String) throws -> RPCRequest {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw RPCError.parse("not JSON") }
    guard let method = obj["method"] as? String else { throw RPCError.invalidRequest("missing `method`") }
    let id = obj["id"].map { JSONValue(any: $0) }
    let params = (obj["params"] as? [String: Any])?.mapValues { JSONValue(any: $0) } ?? [:]
    return RPCRequest(id: id, method: method, params: params)
}

// stdin reader. Reading a line at a time keeps framing trivial and means a
// malformed request can never desynchronise the stream.
let reader = Thread {
    let stdinFile = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdinFile.availableData
        if chunk.isEmpty {
            // Parent closed the pipe: our cue to leave. Hop through the main
            // queue first so requests already dispatched there still get their
            // replies out — otherwise a client that writes and closes in one
            // breath gets nothing back.
            Out.log("info", "stdin closed, draining then exiting")
            DispatchQueue.main.async { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { exit(0) } }
            return
        }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0a) {
            let lineData = buffer[buffer.startIndex..<nl]
            buffer = buffer[buffer.index(after: nl)...]
            guard let line = String(data: lineData, encoding: .utf8),
                  !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            do {
                let req = try parse(line)
                DispatchQueue.main.async { handle(req) }
            } catch let e as RPCError {
                Out.error(id: nil, e)
                Out.log("warn", "bad request", ["error": e.message])
            } catch {
                Out.log("warn", "bad request", ["error": String(describing: error)])
            }
        }
    }
}
reader.stackSize = 512 * 1024
reader.start()

Out.log("info", "buddyd ready", ["version": BUDDYD_VERSION, "pid": Int(getpid())])
Out.write(["jsonrpc": "2.0", "method": "ready",
           "params": ["version": BUDDYD_VERSION, "pid": Int(getpid())]])

// AppKit needs an activation policy or NSWorkspace/AX behave oddly; .accessory
// keeps buddyd out of the Dock and the ⌘-Tab switcher.
NSApplication.shared.setActivationPolicy(.accessory)
RunLoop.main.run()
