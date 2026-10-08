import Foundation
import AVFoundation
import CoreAudio

/// Speaking: `AVSpeechSynthesizer`, which is PRD §9's `VoiceIO` seam filled in
/// on the output side.
///
/// Nothing here needs a permission and nothing here leaves the machine — macOS
/// synthesizes locally, the same way recognition does. What it does need is
/// restraint, because **speaking is the one thing buddy does that other people
/// in the room can hear**. Everything buddy has to say is derived from the
/// person's screen, and §5.2's whole argument is about where that is allowed to
/// go. A sentence read aloud has left the machine in the way a sentence on the
/// screen has not.
///
/// So two rules live down here rather than in the UI, where they could be
/// forgotten:
///
///   - **Not while somebody is using the microphone.** If the input device is
///     running, the person is on a call, and buddy would be talking over them
///     and into it. That is read from CoreAudio, not guessed from a calendar.
///   - **One utterance at a time, and the newest wins.** A queue of things
///     buddy wanted to say thirty seconds ago is noise; what it has to say now
///     replaces it.
final class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Speak.event("started", utterance)
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Speak.event("finished", utterance)
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Speak.event("cancelled", utterance)
    }
}

enum Speak {

    private static let synth = AVSpeechSynthesizer()
    private static let delegate = SpeakDelegate()
    private static var started = false
    /// The id the caller gave the utterance in flight, so a `finished` event
    /// can be matched to the thing that was said.
    private static var currentId = 0
    private static var speaking = 0
    /// Utterance → id. An `AVSpeechUtterance` is handed back in the delegate
    /// callbacks, so the id travels with the object rather than in a variable
    /// a second `speak` would have overwritten.
    private static var ids = NSMapTable<AVSpeechUtterance, NSNumber>.weakToStrongObjects()

    private static func ensure() {
        if !started {
            synth.delegate = delegate
            started = true
        }
    }

    static func event(_ state: String, _ utterance: AVSpeechUtterance) {
        let id = (ids.object(forKey: utterance))?.intValue ?? 0
        if state != "started", id == currentId { speaking = 0 }
        if state == "started" { speaking = id }
        Out.write(["jsonrpc": "2.0", "method": "speak_event",
                   "params": ["id": id, "state": state]])
    }

    // MARK: - Voices

    /// Every installed voice for the language, best first.
    ///
    /// Quality is the whole difference between this feature being pleasant and
    /// being a 1997 robot, and the good voices are an optional download — so
    /// the list says which is which and the UI can tell someone where to get a
    /// better one rather than leaving them to conclude buddy sounds bad.
    static func voices(_ params: [String: JSONValue]) -> [String: Any] {
        let want = (params["language"]?.stringValue ?? "en").lowercased()
        let all = AVSpeechSynthesisVoice.speechVoices()
            .filter { want.isEmpty || $0.language.lowercased().hasPrefix(want) }
        let rank: (AVSpeechSynthesisVoice) -> Int = { v in
            switch v.quality {
            case .premium: return 0
            case .enhanced: return 1
            default: return 2
            }
        }
        // Within a quality tier, the voice the person chose in System Settings
        // wins: buddy should sound like their Mac unless a better-quality
        // voice has been downloaded since.
        let systemDefault = AVSpeechSynthesisVoice(language: nil)?.identifier
        let sorted = all.sorted { a, b in
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            if (a.identifier == systemDefault) != (b.identifier == systemDefault) {
                return a.identifier == systemDefault
            }
            return a.name < b.name
        }
        return [
            "voices": sorted.map { v in
                [
                    "id": v.identifier,
                    "name": v.name,
                    "language": v.language,
                    "quality": v.quality == .premium ? "premium" : v.quality == .enhanced ? "enhanced" : "default",
                ]
            },
            // What buddy would use with nothing configured: the best installed
            // voice for the language, which is not the system default when the
            // person has downloaded a better one.
            "preferred": sorted.first?.identifier as Any? ?? NSNull(),
            "systemDefault": AVSpeechSynthesisVoice(language: nil)?.identifier as Any? ?? NSNull(),
        ]
    }

    // MARK: - Speaking

    static func speak(_ params: [String: JSONValue]) throws -> [String: Any] {
        guard let text = params["text"]?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RPCError.invalidParams("speak requires `text`")
        }
        let id = params["id"]?.intValue ?? 0
        // Checked here and not only in the caller: this is the rule that keeps
        // what buddy read off a screen out of a room it does not belong in,
        // and a rule that lives only in the layer above is one a later caller
        // can forget.
        //
        // Through headphones there is nothing to protect — the sentence
        // reaches one person. Through the built-in speakers it is in the room,
        // so it is skipped when the person asked for headphones only, and
        // always when somebody is on a call, where it would be transmitted.
        // `ourMic` is the caller saying buddy's own listener is what has the
        // microphone open, because the system cannot say who.
        if params["force"]?.boolValue != true, !AudioDevices.outputIsPrivate() {
            if params["headphonesOnly"]?.boolValue == true {
                return ["speaking": false, "id": id, "skipped": "no_headphones"]
            }
            if params["ourMic"]?.boolValue != true, AudioDevices.inputInUse() {
                return ["speaking": false, "id": id, "skipped": "microphone_in_use"]
            }
        }
        ensure()
        // The newest thing to say replaces whatever is still being said.
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }

        let u = AVSpeechUtterance(string: String(text.prefix(2_000)))
        if let vid = params["voice"]?.stringValue, !vid.isEmpty,
           let v = AVSpeechSynthesisVoice(identifier: vid) {
            u.voice = v
        } else if let preferred = (voices(["language": .string("en")])["preferred"] as? String),
                  let v = AVSpeechSynthesisVoice(identifier: preferred) {
            // The same choice `speak_voices` shows as "preferred", so what
            // Settings says buddy will use is what it uses.
            u.voice = v
        }
        // `rate` arrives 0…1 as a fraction of the useful range rather than as
        // AVFoundation's own scale, whose default is 0.5 and whose extremes are
        // unusable in both directions.
        if let r = params["rate"]?.doubleValue {
            let t = max(0, min(1, r))
            u.rate = Float(0.35 + t * 0.3)
        } else {
            u.rate = AVSpeechUtteranceDefaultSpeechRate
        }
        if let v = params["volume"]?.doubleValue { u.volume = Float(max(0, min(1, v))) }
        u.preUtteranceDelay = 0
        u.postUtteranceDelay = 0

        currentId = id
        ids.setObject(NSNumber(value: id), forKey: u)
        synth.speak(u)
        return ["speaking": true, "id": id]
    }

    static func stop() -> [String: Any] {
        guard started else { return ["speaking": false] }
        let was = synth.isSpeaking
        if was { synth.stopSpeaking(at: .immediate) }
        speaking = 0
        return ["speaking": false, "stopped": was]
    }

    static func status() -> [String: Any] {
        var out: [String: Any] = [
            "speaking": started && synth.isSpeaking,
            "id": speaking,
            "voices": AVSpeechSynthesisVoice.speechVoices().count,
        ]
        out.merge(AudioDevices.outputSummary()) { a, _ in a }
        return out
    }
}

extension AudioDevices {

    /// Is anything using the microphone right now?
    ///
    /// `kAudioDevicePropertyDeviceIsRunningSomewhere` is the system's own
    /// answer to "is some process running this device" — it is what the orange
    /// dot in the menu bar is drawn from.
    ///
    /// **It cannot say who.** When buddy's own "hey buddy" listener is open,
    /// this is true because of buddy, and there is no public API that separates
    /// the two. So the caller is told whether buddy is holding it, and when it
    /// is, this signal is not used to decide anything — which is stated in
    /// Settings rather than left as a surprise during a call.
    static func inputInUse() -> Bool {
        for id in [defaultInput(), builtInInput()].compactMap({ $0 }) where isRunning(id) {
            return true
        }
        return false
    }

    static func isRunning(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &running) == noErr && running != 0
    }

    static func defaultOutput() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return st == noErr && id != 0 ? id : nil
    }

    /// Is the sound going somewhere only this person can hear?
    ///
    /// The distinction the speaking rules are built on: through headphones,
    /// what buddy reads off the screen stays with the person it belongs to;
    /// through the built-in speakers it is in the room, and on a call it is
    /// transmitted. macOS exposes no "is this a headset" flag, so this is a
    /// transport check with a name check behind it — Bluetooth and USB audio
    /// are nearly always worn, and the headphone jack presents as a built-in
    /// device whose name says what it is.
    static func outputIsPrivate() -> Bool {
        guard let id = defaultOutput() else { return false }
        if isBluetooth(id) { return true }
        let t = transport(id)
        if t == kAudioDeviceTransportTypeUSB || t == kAudioDeviceTransportTypeAirPlay { return t == kAudioDeviceTransportTypeUSB }
        let name = (name(id) ?? "").lowercased()
        if name.contains("speaker") { return false }
        return name.contains("headphone") || name.contains("headset") || name.contains("airpod") || name.contains("earbud")
    }

    /// What `speak_status` reports, and what Settings explains.
    static func outputSummary() -> [String: Any] {
        let id = defaultOutput()
        return [
            "output": (id.flatMap { name($0) }) as Any? ?? NSNull(),
            "outputIsPrivate": outputIsPrivate(),
            "micInUse": inputInUse(),
        ]
    }
}
