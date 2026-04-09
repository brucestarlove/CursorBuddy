/**
 * Voice Response Pipeline
 *
 * Synchronized text reveal + TTS audio + cursor pointing.
 *
 * The core idea: text, voice, and cursor are all timecoded to each
 * other. When Claude says "right over here", the text reveals those
 * words, the voice speaks them, and the cursor flies — all at once.
 *
 * Flow:
 *   1. Full response text arrives from inference
 *   2. Split into sentences, extract POINT tags
 *   3. Prefetch TTS for all sentences in parallel
 *   4. Play back sequentially with synchronized:
 *      a. Text reveal (sentence appears as audio starts)
 *      b. TTS playback (actual spoken audio)
 *      c. Cursor flight (timed to point-bearing sentences)
 *   5. Each sentence waits for its audio to finish before revealing next
 *
 * Duration estimation: MP3 at ~128kbps ≈ 16KB/second.
 * We use this to pace text reveal + cursor timing without needing
 * round-trip IPC to the renderer for playback completion.
 */

const { parseInlinePointTag } = require("../lib/point-parser.js");

/** Regex to match a POINT tag anywhere in text */
const POINT_TAG_RE = /\s*\[POINT:[^\]]*\]\s*/g;

/** Estimate MP3 audio duration from buffer size. MP3 ~128kbps = 16KB/s */
function estimateAudioDurationMs(audioBuffer) {
  if (!audioBuffer || !audioBuffer.length) return 500;
  return Math.max(500, (audioBuffer.length / 16000) * 1000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MAX_TTS_PREFETCH_AHEAD = 2;

class VoiceResponsePipeline {
  /**
   * @param {object} opts
   * @param {() => void} opts.onSpeakStart — first audio about to play
   * @param {() => void} opts.onSpeakEnd — all audio finished
   * @param {(point: object) => void} opts.onPointAt — fly cursor
   * @param {(accumulatedCleanText: string) => void} opts.onRevealText — progressive text reveal
   * @param {(sentenceText: string) => Promise<{audioBase64:string, mimeType:string, audioSizeBytes:number}|null>} opts.speak
   */
  constructor({ onSpeakStart, onSpeakEnd, onPointAt, onRevealText, speak }) {
    this.onSpeakStart = onSpeakStart;
    this.onSpeakEnd = onSpeakEnd;
    this.onPointAt = onPointAt;
    this.onRevealText = onRevealText;  // progressive sentence-by-sentence reveal
    this.speak = speak;

    this.buffer = "";
    this.sentences = [];         // { text, point? }
    this.isPlaying = false;
    this.cancelled = false;
    this.prefetchPromises = new Map();
  }

  /**
   * Feed text from inference. Can be called incrementally (streaming)
   * or with the full response at once.
   */
  feedText(newText) {
    if (this.cancelled) return;
    this.buffer += newText;

    // Extract complete sentences from the buffer (not final yet)
    const extracted = this._extractSentences(this.buffer, false);
    if (extracted.sentences.length > 0) {
      this.buffer = extracted.remainder;
      for (const item of extracted.sentences) {
        this.sentences.push(item);
      }
      this._ensurePrefetchWindow(0);
    }
  }

  /**
   * Signal that inference is complete. Flush buffer and start
   * synchronized playback.
   */
  finish() {
    if (this.cancelled) return;

    // Flush remaining buffer as final sentence(s)
    if (this.buffer.trim()) {
      const extracted = this._extractSentences(this.buffer, true);
      for (const item of extracted.sentences) {
        this.sentences.push(item);
      }
      this.buffer = "";
    }

    this._ensurePrefetchWindow(0);

    // Start synchronized playback
    this._playSynchronized();
  }

  cancel() {
    this.cancelled = true;
    this.sentences = [];
    this.prefetchPromises.clear();
  }

  // ── Internal ──────────────────────────────────────────────

  /**
   * Split text into sentences, extracting POINT tags as timing markers.
   *
   * Strategy:
   *   1. Split on POINT tags first — separates spoken text from tags
   *   2. Within each segment, split on sentence boundaries (.!?)
   *   3. Attach POINT tags to the preceding sentence
   *   4. When isFinal, remaining text becomes a sentence even without punctuation
   */
  _extractSentences(text, isFinal) {
    const sentences = [];
    let pendingPoint = null;

    const parts = text.split(/(\[POINT:[^\]]*\])/g);
    let unprocessed = "";

    for (const part of parts) {
      if (/^\[POINT:[^\]]*\]$/.test(part)) {
        const parsed = parseInlinePointTag(part);
        if (parsed) {
          const textBefore = unprocessed.replace(POINT_TAG_RE, " ").trim();
          if (textBefore) {
            sentences.push({ text: textBefore, point: pendingPoint || null });
            pendingPoint = null;
            unprocessed = "";
          }
          if (sentences.length > 0 && !sentences[sentences.length - 1].point) {
            sentences[sentences.length - 1].point = parsed;
          } else {
            pendingPoint = parsed;
          }
        }
        continue;
      }

      unprocessed += part;

      const sentencePattern = /([^.!?]+[.!?])(?:\s+|$)/g;
      let lastSentenceEnd = 0;
      let match;

      while ((match = sentencePattern.exec(unprocessed)) !== null) {
        const sentenceText = match[1].trim();
        if (sentenceText) {
          sentences.push({
            text: sentenceText,
            point: pendingPoint || null,
          });
          pendingPoint = null;
        }
        lastSentenceEnd = match.index + match[0].length;
      }

      unprocessed = unprocessed.slice(lastSentenceEnd);
    }

    if (isFinal) {
      const finalText = unprocessed.replace(POINT_TAG_RE, " ").trim();
      if (finalText) {
        sentences.push({ text: finalText, point: pendingPoint || null });
        pendingPoint = null;
        unprocessed = "";
      }
      if (pendingPoint && sentences.length > 0) {
        sentences[sentences.length - 1].point = pendingPoint;
      }
      return { sentences, remainder: "" };
    }

    return { sentences, remainder: unprocessed };
  }

  /**
   * Start TTS for a sentence immediately (parallel prefetch).
   */
  _prefetchTTS(index) {
    if (this.prefetchPromises.has(index)) return;
    const sentence = this.sentences[index];
    if (!sentence || !sentence.text.trim()) return;

    const promise = this.speak(sentence.text).then(result => {
      if (this.cancelled) return null;
      return {
        audioBase64: result?.audioBase64,
        mimeType: result?.mimeType || "audio/mpeg",
        audioSizeBytes: result?.audioSizeBytes || 0,
        point: sentence.point,
        text: sentence.text,
      };
    }).catch(() => null);

    this.prefetchPromises.set(index, promise);
  }

  _ensurePrefetchWindow(currentIndex) {
    const lastIndex = Math.min(this.sentences.length - 1, currentIndex + MAX_TTS_PREFETCH_AHEAD - 1);
    for (let i = currentIndex; i <= lastIndex; i++) {
      this._prefetchTTS(i);
    }
  }

  /**
   * Synchronized playback loop.
   *
   * For each sentence:
   *   1. Reveal the sentence text in the panel (progressive)
   *   2. The speak() callback already sent audio to the panel
   *   3. If the sentence has a POINT tag, fly cursor partway through
   *   4. Wait for the estimated audio duration before moving to next
   *
   * This creates the "timecoded" effect: text appears as it's spoken,
   * cursor flies when the voice references an element.
   */
  async _playSynchronized() {
    if (this.cancelled || this.isPlaying) return;
    this.isPlaying = true;
    this.onSpeakStart();

    let accumulatedCleanText = "";

    for (let i = 0; i < this.sentences.length; i++) {
      if (this.cancelled) break;

      this._ensurePrefetchWindow(i);

      const audioPromise = this.prefetchPromises.get(i);
      if (!audioPromise) continue;

      const audio = await audioPromise;
      if (this.cancelled || !audio) continue;

      // ── 1. Reveal this sentence's text ─────────────────────
      accumulatedCleanText += (accumulatedCleanText ? " " : "") + audio.text;
      this.onRevealText(accumulatedCleanText);

      // ── 2. Audio is already being played by the panel ──────
      // (speak() sent it via IPC in the prefetch step)

      // ── 3. Estimate when this sentence finishes speaking ───
      const durationMs = estimateAudioDurationMs(
        audio.audioSizeBytes
          ? { length: audio.audioSizeBytes }
          : audio.audioBase64
            ? { length: Math.ceil(audio.audioBase64.length * 0.75) } // base64 → bytes
            : null
      );

      // ── 4. Fire cursor point partway through the sentence ──
      // Timed at ~60% so the cursor moves when Claude says
      // "right here" / "over there" (which tends to be late in
      // the sentence, not at the start).
      if (audio.point) {
        const pointDelayMs = Math.min(durationMs * 0.6, durationMs - 300);
        setTimeout(() => {
          if (this.cancelled) return;
          this.onPointAt({
            imgX: audio.point.imgX,
            imgY: audio.point.imgY,
            label: audio.point.label,
            screenNumber: audio.point.screenNumber,
            bubbleText: audio.text.slice(0, 80),
          });
        }, Math.max(0, pointDelayMs));
      }

      // ── 5. Wait for audio to finish before next sentence ───
      await sleep(durationMs);
    }

    this.isPlaying = false;
    this.onSpeakEnd();
  }
}

module.exports = { VoiceResponsePipeline };
