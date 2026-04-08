import Foundation
import Security

/// Manages API key storage securely in ~/.cursorbuddy/keys.json.
/// Provides both file-based and in-memory access for runtime use.
final class APIKeysManager {
    static let shared = APIKeysManager()

    private let filePath: String

    // Runtime-cached keys (loaded from file/env once)
    private(set) var anthropicKey: String?
    private(set) var openAIKey: String?
    private(set) var elevenLabsKey: String?
    private(set) var cartesiaKey: String?
    private(set) var deepgramKey: String?
    private(set) var assemblyAIKey: String?

    private init() {
        let path = NSString("~/.cursorbuddy").expandingTildeInPath
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        filePath = (path as NSString).appendingPathComponent("keys.json")
        loadKeys()
    }

    // MARK: - Load

    private func loadKeys() {
        // Environment variables take priority
        if let val = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"], !val.isEmpty {
            anthropicKey = val
        }
        if let val = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !val.isEmpty {
            openAIKey = val
        }
        if let val = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"], !val.isEmpty {
            elevenLabsKey = val
        }
        if let val = ProcessInfo.processInfo.environment["CARTESIA_API_KEY"], !val.isEmpty {
            cartesiaKey = val
        }
        if let val = ProcessInfo.processInfo.environment["DEEPGRAM_API_KEY"], !val.isEmpty {
            deepgramKey = val
        }
        if let val = ProcessInfo.processInfo.environment["ASSEMBLYAI_API_KEY"], !val.isEmpty {
            assemblyAIKey = val
        }

        // File keys as fallback
        guard let data = FileManager.default.contents(atPath: filePath),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return
        }

        if anthropicKey == nil, let val = dict["ANTHROPIC_API_KEY"], !val.isEmpty { anthropicKey = val }
        if openAIKey == nil, let val = dict["OPENAI_API_KEY"], !val.isEmpty { openAIKey = val }
        if elevenLabsKey == nil, let val = dict["ELEVENLABS_API_KEY"], !val.isEmpty { elevenLabsKey = val }
        if cartesiaKey == nil, let val = dict["CARTESIA_API_KEY"], !val.isEmpty { cartesiaKey = val }
        if deepgramKey == nil, let val = dict["DEEPGRAM_API_KEY"], !val.isEmpty { deepgramKey = val }
        if assemblyAIKey == nil, let val = dict["ASSEMBLYAI_API_KEY"], !val.isEmpty { assemblyAIKey = val }

        print("[APIKeysManager] Loaded keys from \(filePath)")
    }

    // MARK: - Save

    func save(
        anthropicKey: String? = nil,
        openAIKey: String? = nil,
        elevenLabsKey: String? = nil,
        cartesiaKey: String? = nil,
        deepgramKey: String? = nil,
        assemblyAIKey: String? = nil
    ) {
        var dict: [String: String] = [:]
        if let v = anthropicKey { dict["ANTHROPIC_API_KEY"] = v }
        if let v = openAIKey { dict["OPENAI_API_KEY"] = v }
        if let v = elevenLabsKey { dict["ELEVENLABS_API_KEY"] = v }
        if let v = cartesiaKey { dict["CARTESIA_API_KEY"] = v }
        if let v = deepgramKey { dict["DEEPGRAM_API_KEY"] = v }
        if let v = assemblyAIKey { dict["ASSEMBLYAI_API_KEY"] = v }

        // Don't save empty strings
        dict = dict.filter { !$0.value.isEmpty }

        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted)
            try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)

            // Update runtime cache
            if let v = anthropicKey { self.anthropicKey = v.isEmpty ? nil : v }
            if let v = openAIKey { self.openAIKey = v.isEmpty ? nil : v }
            if let v = elevenLabsKey { self.elevenLabsKey = v.isEmpty ? nil : v }
            if let v = cartesiaKey { self.cartesiaKey = v.isEmpty ? nil : v }
            if let v = deepgramKey { self.deepgramKey = v.isEmpty ? nil : v }
            if let v = assemblyAIKey { self.assemblyAIKey = v.isEmpty ? nil : v }

            print("[APIKeysManager] Keys saved to \(filePath)")
        } catch {
            print("[APIKeysManager] Failed to save keys: \(error)")
        }
    }

    /// Returns true if at least one LLM key is configured
    var hasLLMKey: Bool {
        anthropicKey != nil || openAIKey != nil
    }

    /// Returns true if at least one TTS key is configured
    var hasTTSKey: Bool {
        elevenLabsKey != nil || cartesiaKey != nil
    }

    /// Returns true if at least one STT key is configured
    var hasSTTKey: Bool {
        openAIKey != nil || deepgramKey != nil || assemblyAIKey != nil
    }
}
