import Foundation
import AVFoundation
import Speech
import CoreAudio
import AudioToolbox

/// "Hey buddy" — the ears.
///
/// buddyd only *transcribes*. It holds the microphone, runs Apple's recognizer,
/// cuts the stream into utterances at pauses, and sends each finished one's
/// text up the pipe. Deciding that "go ahead" means "start the run" is the
/// main process's job: that is where the HUD state lives, and it is the half
/// that can be checked without a microphone.
///
/// Three rules this file exists to keep:
///
///   - **On-device or not at all.** Every request sets
///     `requiresOnDeviceRecognition`, and when the Mac has no on-device English
///     model, listening refuses to start. An always-open microphone streaming
///     the room to a server is not a trade a wake phrase is worth.
///   - **Nothing is kept.** Audio buffers go to the recognizer and nowhere else,
///     and the text goes up the pipe without ever reaching a log line here.
///   - **Never prompt from a poll.** `status` reads authorization; only
///     `requestPermission` asks. A TCC prompt has to be the answer to something
///     the user did.
enum Voice {

    /// English, because the phrases are. A recognizer in the system language
    /// would hear "hey buddy" through a German or Japanese model.
    static let locale = Locale(identifier: "en-US")

    /// An utterance ends when the transcript has not changed for this long.
    /// Short enough that "take over" starts promptly; long enough that a breath
    /// in the middle of "hey buddy … go ahead" does not split it.
    private static let pauseToEnd: TimeInterval = 0.9
    /// A task is retired after this long whatever is happening. On-device tasks
    /// end themselves after a long silence, and a TV talking for a minute would
    /// otherwise grow one transcript without bound.
    private static let maxUtterance: TimeInterval = 45
    /// This many back-to-back tasks dying young means the recognizer is not
    /// going to work (Dictation turned off, the model missing), and restarting
    /// it harder will not change that.
    private static let maxQuickFailures = 5

    private(set) static var listening = false
    private static var engine: AVAudioEngine?
    private static var recognizer: SFSpeechRecognizer?
    private static var task: SFSpeechRecognitionTask?
    private static var hints: [String] = []
    private static var timer: Timer?
    private static var configObserver: NSObjectProtocol?
    private static var restartPending = false
    private static var deviceName: String?
    private static var lastError: String?

    private static var utteranceId = 0
    private static var utteranceText = ""
    private static var utteranceStarted = Date()
    private static var lastChange = Date()
    private static var quickFailures = 0

    /// The one piece of state the audio thread reads. Everything else is only
    /// touched on the main queue — RPC handlers, recognizer callbacks and the
    /// timer all land there — so this is the one lock in the file.
    private static var request: SFSpeechAudioBufferRecognitionRequest?
    private static let requestLock = NSLock()

    // ── Permissions ───────────────────────────────────────────────────────────

    static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "undetermined"
        @unknown default: return "unknown"
        }
    }

    static func speechStatus() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "undetermined"
        @unknown default: return "unknown"
        }
    }

    /// Whether this binary carries the two usage strings. Without them, asking
    /// for either permission does not fail — TCC kills the process — and a
    /// sidecar that dies every time someone clicks Grant is a crash loop with a
    /// friendly button on it. Reported so the checks can assert it.
    static func hasUsageStrings() -> Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil &&
            Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
    }

    static func requestPermission(_ kind: String, done: @escaping ([String: Any]) -> Void) throws {
        guard hasUsageStrings() else {
            throw RPCError.internalError("buddyd was built without its microphone and speech usage strings; rebuild it with sidecar/build.sh")
        }
        switch kind {
        case "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { done(["granted": granted, "status": status()]) }
            }
        case "speech":
            SFSpeechRecognizer.requestAuthorization { s in
                DispatchQueue.main.async { done(["granted": s == .authorized, "status": status()]) }
            }
        default:
            throw RPCError.invalidParams("kind must be microphone | speech")
        }
    }

    // ── Status ────────────────────────────────────────────────────────────────

    private static var probe: SFSpeechRecognizer?

    static func status() -> [String: Any] {
        // Constructing a recognizer does not prompt; it only answers whether the
        // on-device model for `locale` is installed.
        if probe == nil { probe = SFSpeechRecognizer(locale: locale) }
        return [
            "listening": listening,
            "microphone": microphoneStatus(),
            "speech": speechStatus(),
            "onDevice": probe?.supportsOnDeviceRecognition ?? false,
            "inputDevice": (listening ? deviceName : nil) as Any? ?? NSNull(),
            "error": lastError as Any? ?? NSNull(),
            "usageStrings": hasUsageStrings(),
        ]
    }

    // ── Start / stop ──────────────────────────────────────────────────────────

    static func start(hints newHints: [String]) throws -> [String: Any] {
        hints = newHints
        if listening { return status() }

        // Checked rather than discovered: starting the engine without a grant
        // would raise the microphone prompt from inside a background process,
        // which is exactly what "never prompt from a poll" rules out.
        guard microphoneStatus() == "granted" else {
            throw RPCError.internalError("microphone_not_granted: buddy has not been allowed to use the microphone")
        }
        guard speechStatus() == "granted" else {
            throw RPCError.internalError("speech_not_granted: buddy has not been allowed to use Speech Recognition")
        }
        guard let r = SFSpeechRecognizer(locale: locale) else {
            throw RPCError.internalError("no_recognizer: macOS has no English speech recognizer")
        }
        guard r.supportsOnDeviceRecognition else {
            throw RPCError.internalError("on_device_unavailable: this Mac has no on-device English speech model")
        }
        recognizer = r
        lastError = nil
        quickFailures = 0

        try startEngine()
        listening = true
        beginUtterance()

        let t = Timer(timeInterval: 0.2, repeats: true) { _ in tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t

        Out.log("info", "voice listening", ["device": deviceName ?? "default"])
        return status()
    }

    static func stop() -> [String: Any] {
        guard listening else { return status() }
        listening = false
        timer?.invalidate()
        timer = nil
        requestLock.lock()
        let r = request
        request = nil
        requestLock.unlock()
        r?.endAudio()
        task?.cancel()
        task = nil
        stopEngine()
        Out.log("info", "voice stopped")
        return status()
    }

    /// Something outside the RPC surface ended listening — the device went
    /// away, the recognizer will not run. Said once, with a reason, and left
    /// off: the main process decides whether to try again.
    private static func fail(_ message: String) {
        lastError = message
        Out.log("warn", "voice stopped on its own", ["error": message])
        _ = stop()
        Out.write(["jsonrpc": "2.0", "method": "voice_state",
                   "params": ["listening": false, "error": message]])
    }

    // ── The microphone ────────────────────────────────────────────────────────

    private static func startEngine() throws {
        // A fresh engine each time. A reused one keeps the format of the device
        // it was first started on, and a tap installed with a stale format is
        // an exception, not an error.
        let e = AVAudioEngine()
        let input = e.inputNode
        deviceName = selectInputDevice(input)
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw RPCError.internalError("no_input_device: there is no microphone to listen on")
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            requestLock.lock()
            let r = request
            requestLock.unlock()
            r?.append(buffer)
        }
        e.prepare()
        do {
            try e.start()
        } catch {
            input.removeTap(onBus: 0)
            throw RPCError.internalError("audio_engine: \(error.localizedDescription)")
        }
        engine = e
        // Plugging in a headset or changing the input in Control Center stops
        // the engine underneath us. Restarted rather than reported, because the
        // user did nothing to voice — they changed their microphone.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: e, queue: .main
        ) { _ in scheduleEngineRestart() }
    }

    private static func stopEngine() {
        if let o = configObserver { NotificationCenter.default.removeObserver(o) }
        configObserver = nil
        guard let e = engine else { return }
        e.inputNode.removeTap(onBus: 0)
        e.stop()
        engine = nil
    }

    private static func scheduleEngineRestart() {
        guard listening, !restartPending else { return }
        restartPending = true
        // Coalesced: one device change arrives as a burst of notifications.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            restartPending = false
            guard listening else { return }
            stopEngine()
            do {
                try startEngine()
                Out.log("info", "voice moved to a new input", ["device": deviceName ?? "default"])
            } catch {
                fail("The microphone changed and buddy could not listen on the new one: \(error)")
            }
        }
    }

    /// AirPods and other Bluetooth headsets drop to their call-quality profile
    /// the moment anything opens their microphone: music turns into a phone
    /// line for as long as the mic is held, which for a wake phrase is always.
    /// So when the default input is Bluetooth and the Mac has a built-in
    /// microphone, buddy listens on the built-in one. Any other default — a USB
    /// mic, a display's mic — is what the user chose, and is respected.
    private static func selectInputDevice(_ input: AVAudioInputNode) -> String? {
        guard let current = AudioDevices.defaultInput() else { return nil }
        guard AudioDevices.isBluetooth(current), let builtIn = AudioDevices.builtInInput(),
              let unit = input.audioUnit else {
            return AudioDevices.name(current)
        }
        var id = builtIn
        let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                      kAudioUnitScope_Global, 0, &id,
                                      UInt32(MemoryLayout<AudioDeviceID>.size))
        if st != noErr {
            Out.log("warn", "could not move voice off the Bluetooth input", ["status": Int(st)])
            return AudioDevices.name(current)
        }
        return AudioDevices.name(builtIn)
    }

    // ── Utterances ────────────────────────────────────────────────────────────

    /// One recognition task per utterance. The tap never stops: swapping
    /// `request` is all it takes to start the next one, so nothing said across
    /// the boundary is lost.
    private static func beginUtterance() {
        guard listening, let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.contextualStrings = hints
        req.addsPunctuation = false

        utteranceId += 1
        let id = utteranceId
        utteranceText = ""
        utteranceStarted = Date()
        lastChange = Date()

        requestLock.lock()
        request = req
        requestLock.unlock()

        task = recognizer.recognitionTask(with: req) { result, error in
            // Delivered on the recognizer's queue, which is main. A callback for
            // a retired utterance is the tail of one already handed on.
            guard listening, id == utteranceId else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                // Held here, not sent: the main process acts only on finished
                // utterances (see voice/match.ts), so partial transcripts of
                // whatever the room is saying have no reason to leave buddyd.
                if text != utteranceText {
                    utteranceText = text
                    lastChange = Date()
                    quickFailures = 0
                }
                if result.isFinal {
                    endUtterance()
                    return
                }
            }
            if let error {
                // The common case is not a failure: an on-device task ends
                // itself after a stretch of silence and says so with an error.
                // A task that dies young and empty, again and again, is.
                let young = Date().timeIntervalSince(utteranceStarted) < 1.0 && utteranceText.isEmpty
                quickFailures = young ? quickFailures + 1 : 0
                if quickFailures >= maxQuickFailures {
                    fail("Speech recognition keeps failing: \(error.localizedDescription)")
                    return
                }
                endUtterance()
            }
        }
    }

    private static func endUtterance() {
        let id = utteranceId
        let text = utteranceText
        let oldTask = task
        requestLock.lock()
        let oldRequest = request
        requestLock.unlock()

        // Start the next one before retiring this one, so the audio between the
        // two has somewhere to go.
        beginUtterance()
        oldRequest?.endAudio()
        oldTask?.cancel()
        if !text.isEmpty { emit(id, text) }
    }

    private static func tick() {
        guard listening else { return }
        let now = Date()
        if !utteranceText.isEmpty && now.timeIntervalSince(lastChange) >= pauseToEnd {
            endUtterance()
        } else if now.timeIntervalSince(utteranceStarted) >= maxUtterance {
            endUtterance()
        }
    }

    private static func emit(_ id: Int, _ text: String) {
        Out.write(["jsonrpc": "2.0", "method": "voice_utterance",
                   "params": ["id": id, "text": text]])
    }
}

/// The few CoreAudio questions voice needs answered. Read-only: nothing here
/// changes a system default — the input is chosen per engine, for buddy alone.
enum AudioDevices {

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
        -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                                   mElement: kAudioObjectPropertyElementMain)
    }

    static func defaultInput() -> AudioDeviceID? {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return st == noErr && id != 0 ? id : nil
    }

    static func all() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        let sys = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = address(kAudioDevicePropertyTransportType)
        var t: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &t) == noErr ? t : 0
    }

    static func isBluetooth(_ id: AudioDeviceID) -> Bool {
        let t = transport(id)
        return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
    }

    static func hasInput(_ id: AudioDeviceID) -> Bool {
        var addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
    }

    static func builtInInput() -> AudioDeviceID? {
        all().first { transport($0) == kAudioDeviceTransportTypeBuiltIn && hasInput($0) }
    }

    static func name(_ id: AudioDeviceID) -> String? {
        var addr = address(kAudioObjectPropertyName)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr,
              let n = name?.takeRetainedValue() else { return nil }
        return n as String
    }

    /// For `voice_devices`: what buddy would listen on, and why. Lets the
    /// checks exercise the Bluetooth rule without opening a microphone.
    static func summary() -> [String: Any] {
        let def = defaultInput()
        let builtIn = builtInInput()
        let wouldUse = def.flatMap { isBluetooth($0) ? (builtIn ?? $0) : $0 }
        return [
            "defaultInput": def.flatMap(name) as Any? ?? NSNull(),
            "defaultIsBluetooth": def.map(isBluetooth) ?? false,
            "builtInInput": builtIn.flatMap(name) as Any? ?? NSNull(),
            "wouldListenOn": wouldUse.flatMap(name) as Any? ?? NSNull(),
        ]
    }
}
