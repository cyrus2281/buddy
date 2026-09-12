import Foundation

/// Line-delimited JSON-RPC 2.0 over stdio. One request per line, one response
/// per line. Notifications (no `id`) get no response.
///
/// Every macOS primitive buddy needs lives behind this surface, so the Electron
/// shell can be replaced without touching capture, input, or AX code.

struct RPCRequest {
    let id: JSONValue?
    let method: String
    let params: [String: JSONValue]
}

enum RPCError: Error {
    case parse(String)
    case invalidRequest(String)
    case methodNotFound(String)
    case invalidParams(String)
    case internalError(String)

    var code: Int {
        switch self {
        case .parse: return -32700
        case .invalidRequest: return -32600
        case .methodNotFound: return -32601
        case .invalidParams: return -32602
        case .internalError: return -32603
        }
    }

    var message: String {
        switch self {
        case .parse(let m), .invalidRequest(let m), .methodNotFound(let m),
             .invalidParams(let m), .internalError(let m):
            return m
        }
    }
}

/// A minimal JSON tree. Codable's generated conformances can't round-trip
/// heterogeneous JSON, and pulling in a dependency for this would defeat the
/// point of a zero-dependency sidecar.
indirect enum JSONValue {
    case null
    case bool(Bool)
    case number(Double)
    case int(Int)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(any: Any) {
        switch any {
        case is NSNull: self = .null
        case let b as Bool: self = .bool(b)
        case let i as Int: self = .int(i)
        case let d as Double: self = .number(d)
        case let n as NSNumber:
            // NSNumber erases Bool/Int/Double; recover from the ObjC type code.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) }
            else if strcmp(n.objCType, "d") == 0 || strcmp(n.objCType, "f") == 0 { self = .number(n.doubleValue) }
            else { self = .int(n.intValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSONValue(any: $0) })
        case let o as [String: Any]: self = .object(o.mapValues { JSONValue(any: $0) })
        default: self = .null
        }
    }

    var foundation: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let d): return d
        case .int(let i): return i
        case .string(let s): return s
        case .array(let a): return a.map { $0.foundation }
        case .object(let o): return o.mapValues { $0.foundation }
        }
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    var intValue: Int? {
        switch self {
        case .int(let i): return i
        case .number(let d): return Int(d)
        default: return nil
        }
    }
    var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .number(let d): return d
        default: return nil
        }
    }
    var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
}

/// stdout is the RPC channel and must carry nothing but responses; every log
/// line goes to stderr, which the supervisor folds into its own structured log.
enum Out {
    private static let lock = NSLock()

    static func write(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        else { return }
        lock.lock()
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
        lock.unlock()
    }

    static func result(id: JSONValue?, _ value: [String: Any]) {
        guard let id else { return }  // notification: no reply
        write(["jsonrpc": "2.0", "id": id.foundation, "result": value])
    }

    static func error(id: JSONValue?, _ err: RPCError) {
        guard let id else { return }
        write(["jsonrpc": "2.0", "id": id.foundation,
               "error": ["code": err.code, "message": err.message]])
    }

    static func log(_ level: String, _ message: String, _ fields: [String: Any] = [:]) {
        var o: [String: Any] = ["level": level, "msg": message, "t": Date().timeIntervalSince1970]
        o.merge(fields) { a, _ in a }
        guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([0x0a]))
    }
}
