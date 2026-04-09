/// <reference types="vite/client" />

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Electron overlay preload bridge */
interface ElectronAPI {
  // Cursor
  onCursorPosition: (callback: (position: { x: number; y: number }) => void) => () => void;
  setWindowPosition: (x: number, y: number) => void;
  setFollowingCursor: (following: boolean) => void;

  // Overlay commands (from panel)
  onOverlayCommand: (callback: (command: string, payload: Record<string, unknown>) => void) => () => void;

  // Screen
  onScreenBounds: (callback: (bounds: ScreenBounds) => void) => () => void;
  getScreenBounds: () => Promise<ScreenBounds>;

  // Inference
  onInferenceChunk: (callback: (chunk: { type: string; text?: string; error?: string }) => void) => () => void;
  runInference: (params: { transcript: string; provider?: string; model?: string; attachments?: string[]; voiceMode?: boolean }) => void;

  // STT
  onTranscript: (callback: (data: { text: string; isFinal: boolean }) => void) => () => void;
  sendAudio: (pcm16ArrayBuffer: ArrayBuffer) => void;

  // Push-to-talk
  onPushToTalk: (callback: (action: string) => void) => () => void;
  stopPushToTalk: () => void;
  onVoiceAudioChunk: (callback: (data: { audioBase64?: string; mimeType?: string }) => void) => () => void;

  // TTS
  speak: (text: string) => Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
