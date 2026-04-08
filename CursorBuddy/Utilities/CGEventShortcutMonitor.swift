import AppKit
import Carbon
import Foundation

/// Modern global keyboard shortcut monitor using CGEvent.
///
/// Listens for a specific keyboard shortcut globally using macOS's CGEvent tap API.
/// Falls back to the Carbon-based GlobalPushToTalkShortcutMonitor if needed.
///
/// Usage:
///   let monitor = ModernGlobalShortcutMonitor()
///   monitor.keyCode = UInt32(kVK_Space)
///   monitor.modifiers = UInt32(controlKey | optionKey)
///   monitor.onShortcutPressed = { ... }
///   monitor.onShortcutReleased = { ... }
///   monitor.start()
final class ModernGlobalShortcutMonitor {

    // MARK: - Configuration

    var keyCode: UInt32 = UInt32(kVK_Space)
    var modifiers: UInt32 = UInt32(controlKey | optionKey)

    // MARK: - Callbacks

    var onShortcutPressed: (() -> Void)?
    var onShortcutReleased: (() -> Void)?

    // MARK: - Internal State

    private(set) var isRunning: Bool = false
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private(set) var isPressed: Bool = false

    deinit { stop() }

    // MARK: - Public

    @discardableResult
    func start() -> Bool {
        // If the event tap is already running, don't restart it.
        // Restarting resets isPressed, which would break the shortcut
        // mid-press when the permission poller calls start() every few seconds.
        guard !isRunning else { return true }

        // Listen-only tap: doesn't consume events, so other apps still receive
        // them. More reliable than .defaultTap for modifier-only shortcuts and
        // less likely to be disabled by the system.
        let eventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(eventMask),
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<ModernGlobalShortcutMonitor>.fromOpaque(refcon).takeUnretainedValue()
                return monitor.handleEvent(proxy: proxy, type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            print("[ModernShortcut] Failed to create event tap. Check Accessibility permissions.")
            return false
        }

        eventTap = tap

        // Add to the main run loop (not the current one) so events are
        // always processed on the main thread, matching Clicky's behavior.
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        isRunning = true
        print("[ModernShortcut] Event tap started (keyCode: \(keyCode), modifiers: \(modifiers))")
        return true
    }

    func stop() {
        guard isRunning else { return }

        isPressed = false

        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            runLoopSource = nil
        }

        if let tap = eventTap {
            CFMachPortInvalidate(tap)
            eventTap = nil
        }

        isRunning = false
        print("[ModernShortcut] Event tap stopped")
    }

    // MARK: - Event Handler

    /// Converts Carbon modifier bitmask to NSEvent.ModifierFlags for reliable comparison.
    /// This matches Clicky's approach of using NSEvent.ModifierFlags.contains() which is
    /// proven to work correctly for modifier-only shortcuts like Ctrl+Option.
    private var requiredNSFlags: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if modifiers & UInt32(controlKey) != 0 { flags.insert(.control) }
        if modifiers & UInt32(optionKey) != 0 { flags.insert(.option) }
        if modifiers & UInt32(shiftKey) != 0 { flags.insert(.shift) }
        if modifiers & UInt32(cmdKey) != 0 { flags.insert(.command) }
        return flags
    }

    /// The NSEvent.ModifierFlags for the key that IS the shortcut trigger (when it's a modifier key).
    private var targetNSFlag: NSEvent.ModifierFlags? {
        switch Int(keyCode) {
        case kVK_Command, kVK_RightCommand: return .command
        case kVK_Control, kVK_RightControl: return .control
        case kVK_Option, kVK_RightOption: return .option
        case kVK_Shift, kVK_RightShift: return .shift
        default: return nil
        }
    }

    private func handleEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // Handle tap being disabled by the system
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        // ── Modifier-only shortcut (e.g. Ctrl+Option) ──
        // Uses Clicky's proven approach: convert CGEvent flags to NSEvent.ModifierFlags,
        // strip device-dependent bits, and just check .contains(). No keyCode matching,
        // no "extra forbidden modifiers" — just: are the required modifiers all held?
        if let targetNSFlag, type == .flagsChanged {
            let eventNSFlags = NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue))
                .intersection(.deviceIndependentFlagsMask)

            // All required modifiers PLUS the target modifier key must be held
            let allRequired = requiredNSFlags.union(targetNSFlag)
            let isShortcutCurrentlyPressed = eventNSFlags.contains(allRequired)

            if isShortcutCurrentlyPressed && !isPressed {
                isPressed = true
                // Call directly — this callback already runs on the main thread
                // (added to CFRunLoopGetMain). Do NOT use DispatchQueue.main.async
                // as it won't fire reliably when the app is in the background.
                onShortcutPressed?()
            } else if !isShortcutCurrentlyPressed && isPressed {
                isPressed = false
                onShortcutReleased?()
            }

            return Unmanaged.passUnretained(event)
        }

        // ── Regular key + modifiers shortcut (e.g. Ctrl+Option+Space) ──
        let eventKeyCode = UInt32(event.getIntegerValueField(.keyboardEventKeycode))
        guard eventKeyCode == self.keyCode else {
            return Unmanaged.passUnretained(event)
        }

        let eventNSFlags = NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue))
            .intersection(.deviceIndependentFlagsMask)
        let hasRequiredFlags = eventNSFlags.contains(requiredNSFlags)

        switch type {
        case .keyDown:
            if hasRequiredFlags && !isPressed {
                isPressed = true
                onShortcutPressed?()
            }

        case .keyUp:
            if isPressed {
                isPressed = false
                onShortcutReleased?()
            }

        default:
            break
        }

        return Unmanaged.passUnretained(event)
    }
}

// MARK: - Carbon Legacy Monitor (kept for compatibility)

/// Wrapper that uses the Carbon-based monitor but exposes the same interface.
final class GlobalShortcutMonitorLegacy {

    var keyCode: UInt32 = UInt32(kVK_Space)
    var modifiers: UInt32 = UInt32(controlKey | optionKey)

    var onShortcutPressed: (() -> Void)?
    var onShortcutReleased: (() -> Void)?

    private var carbonMonitor: GlobalPushToTalkShortcutMonitor?

    @discardableResult
    func start() -> Bool {
        carbonMonitor = GlobalPushToTalkShortcutMonitor()
        carbonMonitor?.keyCode = keyCode
        carbonMonitor?.modifiers = modifiers
        carbonMonitor?.onShortcutPressed = onShortcutPressed
        carbonMonitor?.onShortcutReleased = onShortcutReleased
        return carbonMonitor?.start() ?? false
    }

    func stop() {
        carbonMonitor?.stop()
        carbonMonitor = nil
    }
}
