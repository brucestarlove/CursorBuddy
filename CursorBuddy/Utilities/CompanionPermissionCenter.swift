import AppKit
import AVFoundation
import CoreGraphics
import Speech

enum CompanionPermissionCenter {
    /// UserDefaults key for persisting a known-good screen recording grant.
    /// CGPreflightScreenCaptureAccess() can return false negatives after app
    /// restarts even when the user has already approved the app in System
    /// Settings. Once we confirm the permission is granted, we persist that
    /// so future launches don't incorrectly show "not granted".
    private static let screenRecordingConfirmedKey = "com.cursorbuddy.hasPreviouslyConfirmedScreenRecordingPermission"

    static func hasMicrophonePermission() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    static func hasScreenRecordingPermission() -> Bool {
        // CGPreflightScreenCaptureAccess is the official check (macOS 10.15+).
        // Do NOT use CGWindowListCopyWindowInfo as a fallback — it gives false
        // positives/negatives and can trigger permission prompts on some versions.
        let hasPermissionNow = CGPreflightScreenCaptureAccess()
        if hasPermissionNow {
            // Persist the known-good state so false negatives on future launches
            // don't reset the permission UI and force the user to re-grant.
            UserDefaults.standard.set(true, forKey: screenRecordingConfirmedKey)
        }
        return hasPermissionNow
    }

    /// Returns true when the app should treat screen recording as granted for
    /// session purposes. Falls back to the last known granted state because
    /// CGPreflightScreenCaptureAccess() can return false negatives even when
    /// the user has already approved the app. This prevents permissions from
    /// appearing to "reset" on every app restart.
    static func shouldTreatScreenRecordingAsGranted() -> Bool {
        hasScreenRecordingPermission()
            || UserDefaults.standard.bool(forKey: screenRecordingConfirmedKey)
    }

    /// Clears the persisted screen recording confirmation. Call this only when
    /// a capture actually fails with a permission error, which means the user
    /// genuinely revoked the permission.
    static func clearScreenRecordingConfirmation() {
        UserDefaults.standard.removeObject(forKey: screenRecordingConfirmedKey)
    }

    static func hasScreenRecordingPermissionAsync() async -> Bool {
        // Just use the synchronous check. Do NOT call SCShareableContent here —
        // it can trigger a permission prompt dialog, which is the opposite of a check.
        return shouldTreatScreenRecordingAsGranted()
    }

    static func hasAccessibilityPermission() -> Bool {
        AXIsProcessTrusted()
    }

    static func hasSpeechRecognitionPermission() -> Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    static func requestMicrophonePermission(completion: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                completion(granted)
            }
        }
    }

    static func requestScreenRecordingPermission() {
        // Go straight to System Settings. CGRequestScreenCaptureAccess() can
        // trigger repeated system dialogs and doesn't reliably grant permission
        // on newer macOS versions anyway.
        if !hasScreenRecordingPermission() {
            openSystemSettingsPrivacyPane(anchor: "Privacy_ScreenCapture")
        }
    }

    @discardableResult
    static func requestAccessibilityPermission(prompt: Bool = true) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static func requestSpeechRecognitionPermission(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                completion(status == .authorized)
            }
        }
    }

    private static func openSystemSettingsPrivacyPane(anchor: String) {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else {
            return
        }

        NSWorkspace.shared.open(url)
    }
}
