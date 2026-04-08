import Foundation

// MARK: - Transcription Provider Type

enum TranscriptionProviderType: String, CaseIterable, Identifiable {
    case openAI = "openai"
    case deepgram = "deepgram"
    case assemblyAI = "assemblyai"
    case appleSpeech = "apple"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .openAI: return "OpenAI Whisper"
        case .deepgram: return "Deepgram (with VAD)"
        case .assemblyAI: return "AssemblyAI"
        case .appleSpeech: return "Apple Speech (offline)"
        }
    }

    var description: String {
        switch self {
        case .openAI:
            return "Most accurate. Requires OpenAI API key."
        case .deepgram:
            return "Fast with built-in voice activity detection. Requires Deepgram API key."
        case .assemblyAI:
            return "Reliable streaming. Requires AssemblyAI API key."
        case .appleSpeech:
            return "Works offline. No API key needed. Privacy-friendly."
        }
    }

    static var current: TranscriptionProviderType {
        let stored = UserDefaults.standard.string(forKey: "transcriptionProvider") ?? "openai"
        return TranscriptionProviderType(rawValue: stored) ?? .openAI
    }

    mutating func save() {
        UserDefaults.standard.set(rawValue, forKey: "transcriptionProvider")
    }
}

// MARK: - TTS Provider Type

enum TTSProviderType: String, CaseIterable, Identifiable {
    case elevenLabs = "elevenlabs"
    case cartesia = "cartesia"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .elevenLabs: return "ElevenLabs"
        case .cartesia: return "Cartesia (Sonic)"
        }
    }

    var description: String {
        switch self {
        case .elevenLabs:
            return "High quality neural voices. Requires ElevenLabs API key."
        case .cartesia:
            return "Real-time ultra-low latency. Requires Cartesia API key."
        }
    }

    static var current: TTSProviderType {
        let stored = UserDefaults.standard.string(forKey: "ttsProvider") ?? "elevenlabs"
        return TTSProviderType(rawValue: stored) ?? .elevenLabs
    }

    mutating func save() {
        UserDefaults.standard.set(rawValue, forKey: "ttsProvider")
    }
}
