import AVFoundation
import Foundation
import Combine

/// Voice Activity Detection using audio power level analysis.
/// Monitors audio levels and fires onSpeakingStopped when silence exceeds the threshold.
@MainActor
final class VoiceActivityDetector: ObservableObject {

    // MARK: - Published State

    @Published private(set) var isSpeaking: Bool = false
    @Published private(set) var currentPower: Float = 0.0

    // MARK: - Configuration

    /// Power level below which is considered silence (0.0 to 1.0).
    /// Default: 0.03 — about 3% of full scale.
    var silenceThreshold: Float {
        get { UserDefaults.standard.float(forKey: "vadThreshold") == 0 ? 0.03 : UserDefaults.standard.float(forKey: "vadThreshold") }
        set { UserDefaults.standard.set(newValue, forKey: "vadThreshold") }
    }

    /// How many milliseconds of silence triggers the stop callback.
    var silenceDurationMs: Int {
        get {
            let val = UserDefaults.standard.integer(forKey: "vadSilenceMs")
            return val == 0 ? 800 : val
        }
        set { UserDefaults.standard.set(newValue, forKey: "vadSilenceMs") }
    }

    // MARK: - Callbacks

    /// Called when VAD detects the user has stopped speaking.
    /// Note: called from audio thread — dispatch to MainActor before UI updates.
    var onSpeakingStopped: (() -> Void)?

    /// Called when VAD detects the user has started speaking.
    var onSpeakingStarted: (() -> Void)?

    // MARK: - Internal State

    private var silenceStartTime: Date?
    private var lastPowerTime: Date = .now
    private var isMonitoring: Bool = false
    private var monitoringTask: Task<Void, Never>?

    // MARK: - Init

    init() {}

    // MARK: - Public API

    /// Start monitoring audio power levels for voice activity.
    func startMonitoring() {
        guard !isMonitoring else { return }
        isMonitoring = true
        isSpeaking = false
        silenceStartTime = nil
        print("[VAD] Monitoring started (threshold: \(silenceThreshold), silenceMs: \(silenceDurationMs))")
    }

    /// Stop monitoring.
    func stopMonitoring() {
        isMonitoring = false
        monitoringTask?.cancel()
        monitoringTask = nil
        isSpeaking = false
        silenceStartTime = nil
        print("[VAD] Monitoring stopped")
    }

    /// Push a new audio power level sample (0.0 to 1.0) from the audio engine.
    func pushPowerLevel(_ level: Float) {
        guard isMonitoring else { return }

        currentPower = level
        let now = Date()

        if level > silenceThreshold {
            // Voice detected
            if !isSpeaking {
                isSpeaking = true
                onSpeakingStarted?()
                print("[VAD] Speaking started (power: \(String(format: "%.2f", level)))")
            }
            silenceStartTime = now
        } else {
            // Silence
            guard let silenceStart = silenceStartTime else {
                // Wasn't already silent, start timing
                silenceStartTime = now
                return
            }

            let silenceDuration = now.timeIntervalSince(silenceStart) * 1000 // ms

            if silenceDuration > Double(silenceDurationMs) && isSpeaking {
                // Silence threshold exceeded — user stopped speaking
                isSpeaking = false
                let callback = onSpeakingStopped
                print("[VAD] Speaking stopped after \(Int(silenceDuration))ms of silence")
                silenceStartTime = nil
                callback?()
            }
        }

        lastPowerTime = now
    }

    /// Convenience: feed an AVAudioPCMBuffer's power level directly.
    func pushBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        var sum: Float = 0.0
        for i in 0..<frameCount {
            sum += channelData[i] * channelData[i]
        }
        let rms = sqrt(sum / Float(frameCount))
        let power = 20 * log10(max(rms, 0.000001))
        let normalizedPower = max(0.0, min(1.0, (power + 50) / 50))
        pushPowerLevel(normalizedPower)
    }

    /// Reset VAD state (call when starting a new recording).
    func reset() {
        isSpeaking = false
        silenceStartTime = nil
        currentPower = 0.0
    }
}

// MARK: - VAD Integration with BuddyDictationManager

extension BuddyDictationManager {

    /// Returns the VAD instance if VAD is enabled in settings.
    func vadIfEnabled() -> VoiceActivityDetector? {
        guard UserDefaults.standard.bool(forKey: "vadEnabled") else { return nil }
        return VoiceActivityDetector()
    }
}
