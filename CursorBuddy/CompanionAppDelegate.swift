import Cocoa
import SwiftUI
import ServiceManagement
import PostHog
import Foundation
import Carbon

@MainActor
class CompanionAppDelegate: NSObject, NSApplicationDelegate, ObservableObject {

    // MARK: - Shared Instance

    static var shared: CompanionAppDelegate {
        guard let instance = current else {
            fatalError("CompanionAppDelegate accessed before initialization")
        }
        return instance
    }

    private static weak var current: CompanionAppDelegate?

    // MARK: - Properties

    @Published var companionManager: CompanionManager?
    var menuBarPanelManager: MenuBarPanelManager?
    var floatingSessionButtonManager: FloatingSessionButtonManager?

    // Push-to-talk
    private var shortcutMonitor: ShortcutMonitorWrapper?
    private var pttOverlayManager: GlobalPushToTalkOverlayManager?
    private var shortcutChangedObserver: NSObjectProtocol?

    // Cursor overlay
    var elementDetector: ElementLocationDetector?
    var selectedTextMonitor: SelectedTextMonitor?
    private var overlayWindowManager: OverlayWindowManager?
    private var voiceStateObservable: VoiceStateObservable?

    override init() {
        super.init()
        Self.current = self
    }

    // MARK: - NSApplicationDelegate

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupPostHog()
        registerAsLoginItem()
        setupMainMenu()
        initializeManagers()
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    deinit {
        if let shortcutChangedObserver {
            NotificationCenter.default.removeObserver(shortcutChangedObserver)
        }
    }

    // MARK: - Setup

    private func setupPostHog() {
        let posthogApiKey = Bundle.main.object(forInfoDictionaryKey: "POSTHOG_API_KEY") as? String ?? ""
        guard !posthogApiKey.isEmpty else {
            print("[CursorBuddy] PostHog API key not configured, skipping analytics setup.")
            return
        }
        let config = PostHogConfig(apiKey: posthogApiKey, host: "https://app.posthog.com")
        PostHogSDK.shared.setup(config)
        print("[CursorBuddy] PostHog analytics initialized.")
    }

    private func registerAsLoginItem() {
        if #available(macOS 13.0, *) {
            do {
                try SMAppService.mainApp.register()
                print("[CursorBuddy] Registered as login item.")
            } catch {
                print("[CursorBuddy] Failed to register as login item: \(error)")
            }
        }
    }

    // MARK: - Main Menu

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "About CursorBuddy", action: #selector(showAbout), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ","))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Hide CursorBuddy", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthersItem = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthersItem)
        appMenu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Quit CursorBuddy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(NSMenuItem(title: "Toggle Panel", action: #selector(togglePanel), keyEquivalent: "p"))
        viewMenu.addItem(NSMenuItem(title: "Toggle Lens", action: #selector(toggleLens), keyEquivalent: "l"))
        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(NSMenuItem(title: "Full Settings…", action: #selector(showSettings), keyEquivalent: ","))
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.close), keyEquivalent: "w"))
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        // Help menu
        let helpMenuItem = NSMenuItem()
        let helpMenu = NSMenu(title: "Help")
        helpMenu.addItem(NSMenuItem(title: "CursorBuddy Help", action: #selector(showHelp), keyEquivalent: "?"))
        helpMenuItem.submenu = helpMenu
        mainMenu.addItem(helpMenuItem)

        NSApplication.shared.mainMenu = mainMenu
        NSApplication.shared.windowsMenu = windowMenu
        NSApplication.shared.helpMenu = helpMenu

        print("[CursorBuddy] Main menu configured.")
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(nil)
    }

    @objc func showSettings() {
        SettingsWindowController.shared.show()
    }

    @objc private func showHelp() {
        if let url = URL(string: "https://cursorbuddy.app/help") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func togglePanel() {
        menuBarPanelManager?.dismissPanel()
    }

    @objc private func toggleLens() {
        Task { @MainActor in
            LensWindowManager.shared.toggle()
        }
    }

    private func initializeManagers() {
        Task { @MainActor in
            // 1. Core companion manager
            let manager: CompanionManager = CompanionManager()
            self.companionManager = manager

            // 2. Element location detector (cursor overlay)
            let detector = ElementLocationDetector()
            self.elementDetector = detector
            let selectedTextMonitor = SelectedTextMonitor()
            self.selectedTextMonitor = selectedTextMonitor
            // Wire up the element detector to the companion manager
            manager.elementDetector = detector
            manager.selectedTextMonitor = selectedTextMonitor

            // 3. Floating session button
            let floatingManager = FloatingSessionButtonManager()
            self.floatingSessionButtonManager = floatingManager
            manager.screenCapture.floatingButtonWindowToExcludeFromCaptures = floatingManager.floatingButtonPanel

            // 4. Menu bar status item
            let menuBar = MenuBarPanelManager()
            menuBar.companionManager = manager
            menuBar.floatingButtonManager = floatingManager
            menuBar.selectedTextMonitor = selectedTextMonitor
            menuBar.setupStatusItem()
            self.menuBarPanelManager = menuBar

            // 5. Overlay windows (for cursor animation)
            let overlayMgr = OverlayWindowManager.shared
            self.overlayWindowManager = overlayMgr
            let vsObs = VoiceStateObservable()
            self.voiceStateObservable = vsObs
            manager.voiceStateObservable = vsObs
            setupCursorOverlay(
                detector: detector,
                selectedTextMonitor: selectedTextMonitor,
                overlayManager: overlayMgr,
                voiceState: vsObs
            )

            // 6. Push-to-talk shortcut monitor
            observeShortcutChanges()
            setupPushToTalk(companionManager: manager)

            // 7. PTT visual overlay
            let pttOverlay = GlobalPushToTalkOverlayManager()
            self.pttOverlayManager = pttOverlay
            manager.pttOverlayManager = pttOverlay

            APIKeyConfig.printStatus()
            print("[CursorBuddy] All managers initialized. Push-to-talk ready (hold \(PushToTalkShortcutConfiguration.shared.label)).")
            print("[CursorBuddy] Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "??")")
        }
    }

    // MARK: - Cursor Overlay

    @MainActor private func setupCursorOverlay(
        detector: ElementLocationDetector,
        selectedTextMonitor: SelectedTextMonitor,
        overlayManager: OverlayWindowManager,
        voiceState: VoiceStateObservable
    ) {
        // Each screen gets its own CursorOverlayView with that screen's frame,
        // so the cursor only renders on the screen where the mouse actually is.
        overlayManager.setPerScreenContent { screenFrame in
            CursorOverlayView(
                detector: detector,
                voiceState: voiceState,
                selectedTextMonitor: selectedTextMonitor,
                screenFrame: screenFrame
            )
        }
        overlayManager.overlayMode = .idle
        print("[CursorBuddy] Cursor overlay initialized on \(NSScreen.screens.count) screen(s).")
    }

    // MARK: - Push-to-Talk

    @MainActor private func observeShortcutChanges() {
        guard shortcutChangedObserver == nil else { return }

        shortcutChangedObserver = NotificationCenter.default.addObserver(
            forName: PushToTalkShortcutConfiguration.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let companionManager = self.companionManager else { return }
                self.setupPushToTalk(companionManager: companionManager)
            }
        }
    }

    @MainActor private func setupPushToTalk(companionManager: CompanionManager) {
        shortcutMonitor?.stop()

        let shortcutConfig = PushToTalkShortcutConfiguration.shared

        // Try modern CGEvent-based monitor first (better macOS integration)
        let modernMonitor = ModernGlobalShortcutMonitor()
        modernMonitor.keyCode = shortcutConfig.keyCode
        modernMonitor.modifiers = shortcutConfig.modifiers

        modernMonitor.onShortcutPressed = { [weak companionManager] in
            Task { @MainActor in
                guard let manager = companionManager else { return }
                print("[CursorBuddy] Push-to-talk: shortcut PRESSED")
                manager.isRecordingFromKeyboardShortcut = true
                do {
                    try await manager.startSession()
                } catch {
                    print("[CursorBuddy] Push-to-talk start error: \(error)")
                }
            }
        }

        modernMonitor.onShortcutReleased = { [weak companionManager] in
            Task { @MainActor in
                guard let manager = companionManager else { return }
                print("[CursorBuddy] Push-to-talk: shortcut RELEASED")
                manager.isRecordingFromKeyboardShortcut = false
                manager.stopSession()
            }
        }

        let modernStarted = modernMonitor.start()

        if modernStarted {
            // Wrap in the same reference type for stop() compatibility
            let wrapper = ShortcutMonitorWrapper()
            wrapper.modernMonitor = modernMonitor
            self.shortcutMonitor = wrapper
            print("[CursorBuddy] Global push-to-talk hotkey active (CGEvent, \(shortcutConfig.label)).")
        } else {
            // Fall back to Carbon-based monitor
            let carbonMonitor = GlobalPushToTalkShortcutMonitor()
            carbonMonitor.keyCode = shortcutConfig.keyCode
            carbonMonitor.modifiers = shortcutConfig.modifiers
            carbonMonitor.onShortcutPressed = modernMonitor.onShortcutPressed
            carbonMonitor.onShortcutReleased = modernMonitor.onShortcutReleased

            let carbonStarted = carbonMonitor.start()
            if carbonStarted {
                let wrapper = ShortcutMonitorWrapper()
                wrapper.carbonMonitor = carbonMonitor
                self.shortcutMonitor = wrapper
                print("[CursorBuddy] Global push-to-talk hotkey active (Carbon, \(shortcutConfig.label)).")
            } else {
                print("[CursorBuddy] Push-to-talk failed to start (both CGEvent and Carbon failed).")
            }
        }
    }
}

// MARK: - Shortcut Monitor Wrapper (unified interface)

/// Unifies the modern CGEvent monitor and Carbon monitor behind a common stop() interface.
final class ShortcutMonitorWrapper {
    var modernMonitor: ModernGlobalShortcutMonitor?
    var carbonMonitor: GlobalPushToTalkShortcutMonitor?

    init() {}

    func stop() {
        modernMonitor?.stop()
        carbonMonitor?.stop()
    }
}
