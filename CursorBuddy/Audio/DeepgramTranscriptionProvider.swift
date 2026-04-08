import AVFoundation
import Foundation
import Network
import os

// MARK: - Deepgram Provider

/// Deepgram streaming speech-to-text with built-in Voice Activity Detection.
struct DeepgramTranscriptionProvider: BuddyTranscriptionProvider {

    let providerName = "Deepgram"

    var isConfigured: Bool {
        apiKey != nil && !apiKey!.isEmpty
    }

    var requiresSpeechRecognitionPermission: Bool { false }

    private var apiKey: String? {
        APIKeyConfig.deepgramKey
    }

    func createSession() throws -> BuddyStreamingTranscriptionSession {
        guard let key = apiKey else {
            throw DeepgramError.notConfigured
        }
        return DeepgramTranscriptionSession(apiKey: key)
    }
}

// MARK: - Deepgram Session (NWConnection — supports auth headers on WebSocket)

private final class DeepgramTranscriptionSession: BuddyStreamingTranscriptionSession, @unchecked Sendable {

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.cursorbuddy",
        category: "DeepgramSession"
    )

    private let apiKey: String
    private var connection: NWConnection?
    private let pcmConverter = BuddyPCM16AudioConverter()
    private var isConnected = false
    private let queue = DispatchQueue(label: "com.cursorbuddy.deepgram.ws")

    private(set) var isReady: Bool = false
    private(set) var transcriptText: String = ""
    var onTranscriptUpdate: ((String) -> Void)?
    var onError: ((Error) -> Void)?

    init(apiKey: String) {
        self.apiKey = apiKey
    }

    func start() throws {
        pcmConverter.reset()
        transcriptText = ""

        // NWConnection WebSocket with custom Authorization header
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        wsOptions.setAdditionalHeaders([
            ("Authorization", "Token \(apiKey)")
        ])

        let params = NWParameters.tls
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        let url = URL(string: "wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&encoding=linear16&sample_rate=16000&channels=1&vad_events=true&vad_turnoff=500")!
        let endpoint = NWEndpoint.url(url)
        connection = NWConnection(to: endpoint, using: params)

        connection?.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.isConnected = true
                self.isReady = true
                self.logger.info("Deepgram WebSocket connected")
                self.receiveMessages()
            case .failed(let error):
                self.logger.error("Deepgram connection failed: \(error.localizedDescription)")
                DispatchQueue.main.async { self.onError?(error) }
            case .cancelled:
                self.isConnected = false
                self.isReady = false
            default:
                break
            }
        }

        connection?.start(queue: queue)
        logger.info("Deepgram session started")
    }

    func stop() {
        isReady = false

        // Send Finalize to flush pending transcripts, then CloseStream
        if let data = "{\"type\": \"Finalize\"}".data(using: .utf8) {
            let meta = NWProtocolWebSocket.Metadata(opcode: .text)
            let ctx = NWConnection.ContentContext(identifier: "finalize", metadata: [meta])
            connection?.send(content: data, contentContext: ctx, isComplete: true, completion: .idempotent)
        }

        // Wait briefly for final results before closing
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            if let data = "{\"type\": \"CloseStream\"}".data(using: .utf8) {
                let meta = NWProtocolWebSocket.Metadata(opcode: .text)
                let ctx = NWConnection.ContentContext(identifier: "close", metadata: [meta])
                self.connection?.send(content: data, contentContext: ctx, isComplete: true, completion: .idempotent)
            }
            self.isConnected = false
            self.connection?.cancel()
            self.connection = nil
            self.logger.info("Deepgram session stopped")
        }
    }

    private var totalBytesSent = 0

    func feedAudio(buffer: AVAudioPCMBuffer) {
        guard isReady, isConnected else { return }

        pcmConverter.reset()
        pcmConverter.appendAudioPCMBuffer(buffer: buffer)
        let pcmData = pcmConverter.pcm16Data
        guard !pcmData.isEmpty else { return }
        totalBytesSent += pcmData.count
        if totalBytesSent % 32000 < pcmData.count {
            logger.info("Deepgram: sent \(self.totalBytesSent) bytes so far")
        }

        let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
        let ctx = NWConnection.ContentContext(identifier: "audio", metadata: [meta])
        connection?.send(content: pcmData, contentContext: ctx, isComplete: true, completion: .contentProcessed({ [weak self] error in
            if let error {
                self?.logger.warning("Deepgram send error: \(error.localizedDescription)")
            }
        }))
    }

    private func receiveMessages() {
        connection?.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self, self.isConnected else { return }

            if let error {
                self.logger.error("Deepgram receive error: \(error.localizedDescription)")
                DispatchQueue.main.async { self.onError?(error) }
                return
            }

            if let data = content, let text = String(data: data, encoding: .utf8) {
                self.handleMessage(text)
            }

            self.receiveMessages()
        }
    }

    private func handleMessage(_ jsonString: String) {
        logger.info("Deepgram recv: \(jsonString.prefix(200))")
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        if let channel = json["channel"] as? [String: Any],
           let alternatives = channel["alternatives"] as? [[String: Any]],
           let transcript = alternatives.first?["transcript"] as? String,
           !transcript.isEmpty {

            let isFinal = json["speech_final"] as? Bool ?? false

            if isFinal {
                if !transcriptText.isEmpty { transcriptText += " " }
                transcriptText += transcript
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.onTranscriptUpdate?(self.transcriptText)
                }
            } else {
                let displayText = !transcriptText.isEmpty ? "\(transcriptText) \(transcript)" : transcript
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.onTranscriptUpdate?(displayText)
                }
            }
        }

        if let type = json["type"] as? String {
            switch type {
            case "SpeechStarted":
                logger.debug("Deepgram VAD: speech started")
            case "SpeechStopped":
                logger.debug("Deepgram VAD: speech stopped")
            default:
                break
            }
        }
    }
}

// MARK: - Errors

enum DeepgramError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Deepgram API key not configured. Set DEEPGRAM_API_KEY or add it in Settings."
        }
    }
}
