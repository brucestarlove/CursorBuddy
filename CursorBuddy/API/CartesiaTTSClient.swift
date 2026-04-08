import AVFoundation
import Foundation
import os

// MARK: - Cartesia TTS Client

/// Cartesia AI real-time voice synthesis client.
/// Uses the Cartesia REST API for streaming TTS with neural voices.
class CartesiaTTSClient {
    static let shared = CartesiaTTSClient()

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.cursorbuddy",
        category: "CartesiaTTS"
    )

    private var apiKey: String? {
        if let key = ProcessInfo.processInfo.environment["CARTESIA_API_KEY"], !key.isEmpty {
            return key
        }
        return APIKeysManager.shared.cartesiaKey
    }

    private var voiceId: String {
        UserDefaults.standard.string(forKey: "cartesiaVoiceId") ?? ""
    }

    private var audioPlayer: AVAudioPlayer?
    private var currentTask: Task<Data, Error>?

    var isConfigured: Bool {
        apiKey != nil && !apiKey!.isEmpty
    }

    // MARK: - Speak

    /// Speak text using Cartesia API. Returns audio data and plays it.
    func speak(text: String) async throws -> Data {
        guard let apiKey = apiKey, !apiKey.isEmpty else {
            throw CartesiaError.notConfigured
        }

        let voice = voiceId.isEmpty ? "default" : voiceId

        // Build SSE request
        var request = URLRequest(url: URL(string: "https://api.cartesia.ai/tts/stream")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30

        let body: [String: Any] = [
            "model_id": "sonic-2",
            "transcript": text,
            "voice": [
                "mode": "ultra_low_latency",
                "cartesia_voice_id": voice.isEmpty ? "d86c3a72-2a34-4db2-b49e-c693e8c4ae98" : voice
            ],
            "output_format": [
                "container": "mp3",
                "encoding": "mp3"
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        guard httpResponse.statusCode == 200 else {
            var errorBody = ""
            for try await line in bytes.lines {
                errorBody += line
                if errorBody.count > 500 { break }
            }
            logger.error("Cartesia TTS error HTTP \(httpResponse.statusCode): \(errorBody)")
            throw NSError(domain: "CartesiaTTS", code: httpResponse.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "Cartesia TTS failed: \(errorBody)"])
        }

        // Read all bytes into Data
        var audioData = Data()
        for try await byte in bytes {
            audioData.append(byte)
        }

        logger.info("Cartesia TTS: received \(audioData.count) bytes")
        let finalAudioData = audioData

        // Play audio
        try await MainActor.run {
            audioPlayer = try AVAudioPlayer(data: finalAudioData)
            audioPlayer?.play()
        }

        // Wait for playback
        while await MainActor.run(body: { audioPlayer?.isPlaying == true }) {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        return finalAudioData
    }

    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
    }
}

// MARK: - Errors

enum CartesiaError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Cartesia API key not configured. Set CARTESIA_API_KEY or add it in Settings."
        }
    }
}
