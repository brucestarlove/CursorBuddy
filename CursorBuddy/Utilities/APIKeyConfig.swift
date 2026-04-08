import Foundation

/// Central configuration for API keys.
///
/// Keys are loaded in priority order:
///   1. Environment variables (e.g., OPENAI_API_KEY)
///   2. ~/.cursorbuddy/keys.json file
///   3. Info.plist entries
///
/// To configure, create ~/.cursorbuddy/keys.json:
/// ```json
/// {
///     "OPENAI_API_KEY": "sk-...",
///     "ASSEMBLYAI_API_KEY": "...",
///     "ANTHROPIC_API_KEY": "...",
///     "ELEVENLABS_API_KEY": "..."
/// }
/// ```
///
/// Or set environment variables before launching.
enum APIKeyConfig {

    // MARK: - Key Names

    static let openAIKey = resolve("OPENAI_API_KEY", plistKey: "OpenAIAPIKey")
    static let assemblyAIKey = resolve("ASSEMBLYAI_API_KEY", plistKey: "AssemblyAIAPIKey")
    static let assemblyAIStreamingToken = resolve("ASSEMBLYAI_STREAMING_TOKEN", plistKey: "AssemblyAIStreamingToken")
    static let anthropicKey = resolve("ANTHROPIC_API_KEY", plistKey: "AnthropicAPIKey")
    static let elevenLabsKey = resolve("ELEVENLABS_API_KEY", plistKey: "ElevenLabsAPIKey")
    static let cartesiaKey = resolve("CARTESIA_API_KEY", plistKey: "CartesiaAPIKey")
    static let deepgramKey = resolve("DEEPGRAM_API_KEY", plistKey: "DeepgramAPIKey")

    // MARK: - Resolution

    private static var fileKeys: [String: String]? = {
        let path = NSString("~/.cursorbuddy/keys.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
            return nil
        }
        print("[APIKeyConfig] Loaded keys from ~/.cursorbuddy/keys.json")
        return dict
    }()

    private static func resolve(_ envKey: String, plistKey: String) -> String? {
        // 1. Environment variable
        if let val = ProcessInfo.processInfo.environment[envKey], !val.isEmpty {
            return val
        }
        // 2. ~/.cursorbuddy/keys.json
        if let val = fileKeys?[envKey], !val.isEmpty {
            return val
        }
        // 3. Info.plist
        if let val = Bundle.main.object(forInfoDictionaryKey: plistKey) as? String, !val.isEmpty {
            return val
        }
        return nil
    }

    /// Print which keys are configured (for debugging)
    static func printStatus() {
        print("[APIKeyConfig] OpenAI: \(openAIKey != nil ? "✓" : "✗")")
        print("[APIKeyConfig] AssemblyAI: \(assemblyAIKey != nil || assemblyAIStreamingToken != nil ? "✓" : "✗")")
        print("[APIKeyConfig] Anthropic: \(anthropicKey != nil ? "✓" : "✗")")
        print("[APIKeyConfig] ElevenLabs: \(elevenLabsKey != nil ? "✓" : "✗")")
        print("[APIKeyConfig] Cartesia: \(cartesiaKey != nil ? "✓" : "✗")")
        print("[APIKeyConfig] Deepgram: \(deepgramKey != nil ? "✓" : "✗")")
    }
}
