import Foundation
import os

/// OpenAI Codex API client for coding-specific tasks.
/// Uses the same API as OpenAI's chat completions with codex models.
class CodexAPI {
    static let shared = CodexAPI()

    private var apiKey: String? {
        APIKeyConfig.openAIKey
    }

    private let baseURL = "https://api.openai.com/v1"

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.cursorbuddy",
        category: "CodexAPI"
    )

    struct Message: Codable {
        let role: String
        let content: String
    }

    struct Request: Codable {
        let model: String
        let messages: [Message]
        let max_tokens: Int
        let stream: Bool
        let temperature: Double
    }

    // MARK: - Streaming Chat Completion

    func streamingChat(messages: [Message], model: String = "gpt-4o") -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let apiKey = self.apiKey else {
                        throw CodexError.noAPIKey
                    }

                    var request = URLRequest(url: URL(string: "\(self.baseURL)/chat/completions")!)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
                    request.timeoutInterval = 60

                    let body = Request(
                        model: model,
                        messages: messages,
                        max_tokens: 4096,
                        stream: true,
                        temperature: 0.3
                    )
                    request.httpBody = try JSONEncoder().encode(body)

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
                        throw NSError(domain: "CodexAPI", code: httpResponse.statusCode,
                                      userInfo: [NSLocalizedDescriptionKey: "HTTP \(httpResponse.statusCode): \(errorBody)"])
                    }

                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard line.hasPrefix("data: ") else { continue }
                        let data = String(line.dropFirst(6))
                        if data == "[DONE]" { break }

                        if let jsonData = data.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                           let choices = json["choices"] as? [[String: Any]],
                           let first = choices.first,
                           let delta = first["delta"] as? [String: Any],
                           let content = delta["content"] as? String {
                            continuation.yield(content)
                        }
                    }

                    continuation.finish()
                } catch {
                    self.logger.error("Codex API error: \(error.localizedDescription, privacy: .public)")
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

// MARK: - Codex Error

enum CodexError: LocalizedError {
    case noAPIKey

    var errorDescription: String? {
        switch self {
        case .noAPIKey:
            return "OpenAI API key not configured. Add it in Settings > API Keys."
        }
    }
}
