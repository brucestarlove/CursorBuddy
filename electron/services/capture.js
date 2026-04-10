/**
 * Screen Capture Service
 *
 * Cross-platform screenshot capture via Electron's desktopCapturer.
 * Returns labeled JPEG screenshots with full coordinate mapping info
 * so callers can convert between screenshot pixels and screen coords.
 *
 * Key concepts:
 *   display.bounds  = logical screen pixels (e.g. 3840×1620 on a 4K Mac)
 *   scaleFactor     = Retina/HiDPI multiplier (e.g. 2.0)
 *   screenshot      = captured at MAX_DIMENSION on longest edge
 *
 * The screenshot dimensions are included in the label so Claude knows
 * the coordinate space. When Claude returns [POINT:x,y], those coords
 * are in screenshot pixel space and must be scaled to logical screen
 * space before positioning the overlay window.
 */

const { desktopCapturer, screen, nativeImage, BrowserWindow } = require("electron");

let MAX_DIMENSION = 1280;
const JPEG_QUALITY = 80;

/**
 * Update capture settings at runtime.
 * @param {object} opts
 * @param {number} [opts.maxDimension] - max screenshot dimension (longest edge)
 */
function setCaptureSettings(opts) {
  if (opts.maxDimension && opts.maxDimension >= 640 && opts.maxDimension <= 3840) {
    MAX_DIMENSION = opts.maxDimension;
  }
}

/**
 * Anthropic Computer Use recommended resolutions.
 * Pick the one closest to the display's aspect ratio.
 */
const CU_RESOLUTIONS = [
  { w: 1024, h: 768, ar: 1024 / 768 },     // 4:3
  { w: 1280, h: 800, ar: 1280 / 800 },      // 16:10 (Mac default)
  { w: 1366, h: 768, ar: 1366 / 768 },      // ~16:9
];

function bestCUResolution(displayWidth, displayHeight) {
  const ar = displayWidth / Math.max(1, displayHeight);
  let best = CU_RESOLUTIONS[1]; // default 1280×800
  let bestDiff = Infinity;
  for (const r of CU_RESOLUTIONS) {
    const diff = Math.abs(ar - r.ar);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

/**
 * Capture all screens as labeled JPEG base64 strings.
 *
 * Each result includes:
 *   screenshotWidthPx / screenshotHeightPx — the image Claude sees
 *   displayWidthPx / displayHeightPx — the logical screen size
 *   scaleX / scaleY — multiply screenshot coords by these to get screen coords
 */
/**
 * @param {object} [opts]
 * @param {boolean} [opts.primaryOnly] - only capture the screen the cursor is on
 * @param {number}  [opts.maxDimension] - override MAX_DIMENSION for this capture
 */
async function captureAllScreens(opts = {}) {
  const maxDim = opts.maxDimension || MAX_DIMENSION;
  const cursorPoint = screen.getCursorScreenPoint();
  const displays = screen.getAllDisplays();

  // Hide our own windows before capture so the AI doesn't see CursorBuddy UI.
  // Use setOpacity(0) instead of hide()/show() to avoid focus changes and flicker.
  const ownWindows = BrowserWindow.getAllWindows();
  const restoreFns = [];
  for (const win of ownWindows) {
    if (!win.isDestroyed() && win.isVisible()) {
      const prevOpacity = win.getOpacity();
      win.setOpacity(0);
      restoreFns.push(() => { if (!win.isDestroyed()) win.setOpacity(prevOpacity); });
    }
  }

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 3840, height: 2160 }, // request max, we resize ourselves
  });

  // Restore window opacity immediately after capture
  for (const fn of restoreFns) fn();

  const results = [];

  for (let i = 0; i < displays.length; i++) {
    const display = displays[i];
    const isCursorScreen = display.bounds.x <= cursorPoint.x &&
      cursorPoint.x < display.bounds.x + display.bounds.width &&
      display.bounds.y <= cursorPoint.y &&
      cursorPoint.y < display.bounds.y + display.bounds.height;

    // Skip non-primary screens if primaryOnly is set
    if (opts.primaryOnly && !isCursorScreen) continue;

    const source = sources[i] || sources[0];
    if (!source) continue;

    let thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) continue;

    // Resize to maxDim on longest edge, preserving aspect ratio
    const origSize = thumbnail.getSize();
    const aspectRatio = origSize.width / origSize.height;
    let targetWidth, targetHeight;
    if (origSize.width >= origSize.height) {
      targetWidth = Math.min(origSize.width, maxDim);
      targetHeight = Math.round(targetWidth / aspectRatio);
    } else {
      targetHeight = Math.min(origSize.height, maxDim);
      targetWidth = Math.round(targetHeight * aspectRatio);
    }

    thumbnail = thumbnail.resize({ width: targetWidth, height: targetHeight });
    const jpegBuffer = thumbnail.toJPEG(JPEG_QUALITY);
    const base64 = jpegBuffer.toString("base64");

    // Scale factors: screenshot pixels → logical screen pixels
    const scaleX = display.bounds.width / targetWidth;
    const scaleY = display.bounds.height / targetHeight;

    const label = displays.length === 1
      ? `user's screen (cursor is here) (image dimensions: ${targetWidth}x${targetHeight} pixels)`
      : isCursorScreen
        ? `screen ${i + 1} of ${displays.length} - cursor is on this screen (primary focus) (image dimensions: ${targetWidth}x${targetHeight} pixels)`
        : `screen ${i + 1} of ${displays.length} - secondary screen (image dimensions: ${targetWidth}x${targetHeight} pixels)`;

    // workArea excludes menu bar + dock on macOS
    const wa = display.workArea;
    const menuBarHeight = wa.y - display.bounds.y; // typically ~25px on macOS

    results.push({
      imageDataBase64: base64,
      label,
      isCursorScreen,
      displayWidthPx: display.bounds.width,
      displayHeightPx: display.bounds.height,
      displayX: display.bounds.x,
      displayY: display.bounds.y,
      workAreaX: wa.x,
      workAreaY: wa.y,
      workAreaWidth: wa.width,
      workAreaHeight: wa.height,
      menuBarHeight,
      screenshotWidthPx: targetWidth,
      screenshotHeightPx: targetHeight,
      scaleX,
      scaleY,
      scaleFactor: display.scaleFactor,
      cursorX: isCursorScreen ? cursorPoint.x - display.bounds.x : 0,
      cursorY: isCursorScreen ? cursorPoint.y - display.bounds.y : 0,
    });
  }

  results.sort((a, b) => (b.isCursorScreen ? 1 : 0) - (a.isCursorScreen ? 1 : 0));
  return results;
}

/**
 * Convert a POINT coordinate from screenshot pixel space to
 * absolute logical screen coordinates.
 *
 * @param {number} pointX - X in screenshot pixels
 * @param {number} pointY - Y in screenshot pixels
 * @param {object} screenCapture - the capture result for that screen
 * @returns {{ x: number, y: number }} absolute logical screen position
 */
/**
 * Calibration data: { offsetX, offsetY, scaleX, scaleY }
 * Applied after screenshot→screen coordinate conversion.
 * Set by the calibration wizard in the Playground tab.
 */
let calibration = null;

function setCalibration(cal) {
  calibration = cal;
}

function screenshotPointToScreenCoords(pointX, pointY, screenCapture) {
  const clampedX = Math.max(0, Math.min(pointX, screenCapture.screenshotWidthPx));
  const clampedY = Math.max(0, Math.min(pointY, screenCapture.screenshotHeightPx));

  let x = screenCapture.displayX + clampedX * screenCapture.scaleX;
  let y = screenCapture.displayY + clampedY * screenCapture.scaleY;

  // Apply calibration correction if available
  if (calibration) {
    const centerX = screenCapture.displayX + screenCapture.displayWidthPx / 2;
    const centerY = screenCapture.displayY + screenCapture.displayHeightPx / 2;
    // Scale from center
    x = centerX + (x - centerX) * (calibration.scaleX || 1);
    y = centerY + (y - centerY) * (calibration.scaleY || 1);
    // Offset
    x += calibration.offsetX || 0;
    y += calibration.offsetY || 0;
  }

  return { x, y };
}

module.exports = { captureAllScreens, screenshotPointToScreenCoords, bestCUResolution, setCalibration, setCaptureSettings };
