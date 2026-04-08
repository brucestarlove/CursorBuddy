import AppKit
import Foundation

// MARK: - Captured Screenshot

struct CapturedScreenshot: Identifiable {
    let id = UUID()
    let image: NSImage
    let base64JPEG: String
    let source: Source
    let timestamp: Date = Date()

    enum Source: String {
        case clipboard = "Clipboard"
        case file = "Screenshot"
    }

    /// Small thumbnail for UI display
    var thumbnail: NSImage {
        let maxDim: CGFloat = 120
        let size = image.size
        let scale = min(maxDim / size.width, maxDim / size.height, 1.0)
        let thumbSize = NSSize(width: size.width * scale, height: size.height * scale)

        let thumb = NSImage(size: thumbSize)
        thumb.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: thumbSize),
                   from: NSRect(origin: .zero, size: size),
                   operation: .copy, fraction: 1.0)
        thumb.unlockFocus()
        return thumb
    }
}

// MARK: - ScreenshotInterceptor

/// Watches for new screenshots from clipboard (Cmd+Shift+Ctrl+3/4) and
/// the macOS screenshot directory (Cmd+Shift+3/4/5) and surfaces them
/// for the user to optionally attach to the next chat turn.
@MainActor
final class ScreenshotInterceptor: ObservableObject {

    @Published var pendingScreenshot: CapturedScreenshot?

    private var pasteboardChangeCount: Int
    private var timer: Timer?
    private var directorySource: DispatchSourceFileSystemObject?
    private var directoryFD: Int32 = -1
    private var knownFiles: Set<String> = []
    private let screenshotDir: URL

    // Don't intercept images smaller than this (filters out icons, small copies)
    private let minScreenshotPixels: Int = 10_000 // e.g. 100x100

    init() {
        self.pasteboardChangeCount = NSPasteboard.general.changeCount
        self.screenshotDir = Self.screenshotDirectory()

        indexExistingFiles()
        startPasteboardMonitor()
        startDirectoryMonitor()

        print("[ScreenshotInterceptor] Monitoring clipboard + \(screenshotDir.path)")
    }

    deinit {
        timer?.invalidate()
        directorySource?.cancel()
        if directoryFD >= 0 { close(directoryFD) }
    }

    // MARK: - Public

    func dismiss() {
        pendingScreenshot = nil
    }

    // MARK: - Screenshot Directory

    private static func screenshotDirectory() -> URL {
        // macOS stores the custom screenshot location in com.apple.screencapture defaults
        if let custom = UserDefaults(suiteName: "com.apple.screencapture")?.string(forKey: "location") {
            let expanded = NSString(string: custom).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded)
            if FileManager.default.fileExists(atPath: url.path) {
                return url
            }
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
    }

    // MARK: - Pasteboard Monitor

    private func startPasteboardMonitor() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.checkPasteboard()
            }
        }
    }

    private func checkPasteboard() {
        let pb = NSPasteboard.general
        let currentCount = pb.changeCount
        guard currentCount != pasteboardChangeCount else { return }
        pasteboardChangeCount = currentCount

        // Only intercept if there's image data (not just text/files)
        let imageTypes: [NSPasteboard.PasteboardType] = [.png, .tiff]
        guard pb.availableType(from: imageTypes) != nil else { return }

        // Read image from pasteboard
        guard let image = NSImage(pasteboard: pb) else { return }
        let size = image.size
        guard Int(size.width) * Int(size.height) >= minScreenshotPixels else { return }

        // Convert to base64 JPEG
        guard let base64 = imageToBase64JPEG(image) else { return }

        let screenshot = CapturedScreenshot(image: image, base64JPEG: base64, source: .clipboard)
        pendingScreenshot = screenshot
        print("[ScreenshotInterceptor] Clipboard screenshot detected (\(Int(size.width))×\(Int(size.height)))")
    }

    // MARK: - Directory Monitor

    private func indexExistingFiles() {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: screenshotDir.path) else { return }
        knownFiles = Set(files.filter { isScreenshotFile($0) })
    }

    private func startDirectoryMonitor() {
        let path = screenshotDir.path
        directoryFD = open(path, O_EVTONLY)
        guard directoryFD >= 0 else {
            print("[ScreenshotInterceptor] Could not open directory for monitoring: \(path)")
            return
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: directoryFD,
            eventMask: .write,
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                self?.checkForNewScreenshots()
            }
        }

        source.setCancelHandler { [weak self] in
            if let fd = self?.directoryFD, fd >= 0 {
                close(fd)
            }
        }

        source.resume()
        self.directorySource = source
    }

    private func checkForNewScreenshots() {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: screenshotDir.path) else { return }
        let screenshotFiles = Set(files.filter { isScreenshotFile($0) })
        let newFiles = screenshotFiles.subtracting(knownFiles)
        knownFiles = screenshotFiles

        // Pick the most recent new file
        guard let newest = newFiles.sorted().last else { return }

        let fileURL = screenshotDir.appendingPathComponent(newest)

        // Wait a moment for the file to finish writing
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadScreenshotFile(fileURL)
        }
    }

    private func loadScreenshotFile(_ url: URL) {
        guard let image = NSImage(contentsOf: url) else { return }
        let size = image.size
        guard Int(size.width) * Int(size.height) >= minScreenshotPixels else { return }
        guard let base64 = imageToBase64JPEG(image) else { return }

        let screenshot = CapturedScreenshot(image: image, base64JPEG: base64, source: .file)
        pendingScreenshot = screenshot
        print("[ScreenshotInterceptor] File screenshot detected: \(url.lastPathComponent) (\(Int(size.width))×\(Int(size.height)))")
    }

    // MARK: - Helpers

    private func isScreenshotFile(_ filename: String) -> Bool {
        let lower = filename.lowercased()
        guard lower.hasSuffix(".png") || lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") else { return false }
        // macOS screenshot naming patterns
        return lower.hasPrefix("screenshot") ||
               lower.hasPrefix("screen shot") ||
               lower.hasPrefix("cleanshot") ||
               lower.contains("screen recording")
    }

    private func imageToBase64JPEG(_ image: NSImage) -> String? {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            return nil
        }
        return jpeg.base64EncodedString()
    }
}
