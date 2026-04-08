import AppKit
import AVFoundation
import Speech
import Combine

/// Monitors system permission states and posts notifications when they change.
/// This addresses the issue where permissions can silently change (e.g., after a system update).
@MainActor
final class PermissionMonitor: ObservableObject {

    static let shared = PermissionMonitor()

    // MARK: - Published States

    @Published private(set) var microphonePermission: Bool = false
    @Published private(set) var screenRecordingPermission: Bool = false
    @Published private(set) var accessibilityPermission: Bool = false
    @Published private(set) var speechRecognitionPermission: Bool = false

    // MARK: - Notifications

    static let permissionsChangedNotification = Notification.Name("com.cursorbuddy.permissionsChanged")

    // MARK: - Init

    private var pollingTimer: Timer?
    private var cancellables = Set<AnyCancellable>()

    private init() {
        refreshAll()
        startPolling()
    }

    deinit {
        pollingTimer?.invalidate()
    }

    // MARK: - Public

    func refreshAll() {
        microphonePermission = CompanionPermissionCenter.hasMicrophonePermission()
        accessibilityPermission = CompanionPermissionCenter.hasAccessibilityPermission()
        speechRecognitionPermission = CompanionPermissionCenter.hasSpeechRecognitionPermission()

        // Use the persisted fallback so false negatives from
        // CGPreflightScreenCaptureAccess() don't reset the permission UI.
        let screen = CompanionPermissionCenter.shouldTreatScreenRecordingAsGranted()
        let changed = screenRecordingPermission != screen
        screenRecordingPermission = screen
        if changed {
            notifyChange()
        }
    }

    /// Returns true if all required permissions are granted
    var allPermissionsGranted: Bool {
        microphonePermission && screenRecordingPermission && accessibilityPermission && speechRecognitionPermission
    }

    /// Returns a list of missing permissions with human-readable names
    var missingPermissions: [String] {
        var missing: [String] = []
        if !microphonePermission { missing.append("Microphone") }
        if !screenRecordingPermission { missing.append("Screen Recording") }
        if !accessibilityPermission { missing.append("Accessibility") }
        if !speechRecognitionPermission { missing.append("Speech Recognition") }
        return missing
    }

    // MARK: - Private

    private func startPolling() {
        // Check permissions every 10 seconds — cheap to check
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.checkForChanges()
            }
        }
    }

    private func checkForChanges() {
        let prevMic = microphonePermission
        _ = screenRecordingPermission
        let prevAccessibility = accessibilityPermission
        let prevSpeech = speechRecognitionPermission

        refreshAll()

        if microphonePermission != prevMic ||
           accessibilityPermission != prevAccessibility ||
           speechRecognitionPermission != prevSpeech {
            notifyChange()
        }
        // screenRecordingPermission is checked async inside refreshAll
    }

    private func notifyChange() {
        NotificationCenter.default.post(name: Self.permissionsChangedNotification, object: nil)
        print("[PermissionMonitor] Permissions changed. Missing: \(missingPermissions)")
    }
}
