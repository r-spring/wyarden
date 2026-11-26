import * as fs from "fs";

/** Recognition of local GGML model headers, not a full tensor/integrity check.
 * Parakeet and VAD models can also be named ggml-*.bin; the filename/magic alone is insufficient.
 * Header layouts: upstream whisper.cpp/src/whisper.cpp and src/parakeet.cpp model loaders.
 */
function modelHeader(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const h = Buffer.alloc(48);
    if (fs.readSync(fd, h, 0, h.length, 0) !== h.length) return undefined;
    return h;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function hasWhisperHeader(file: string): boolean {
  const h = modelHeader(file);
  if (!h) return false;
  const vocab = h.readInt32LE(4), audioState = h.readInt32LE(12), textState = h.readInt32LE(28), mels = h.readInt32LE(40);
  return h.readUInt32LE(0) === 0x67676d6c && vocab >= 51864 && vocab <= 51866
    && h.readInt32LE(8) === 1500 && h.readInt32LE(24) === 448
    && audioState > 0 && audioState === textState && (mels === 80 || mels === 128);
}

/** Current parakeet-cli GGML TDT layout; recognizes headers, not tensor integrity. */
export function hasParakeetHeader(file: string): boolean {
  const h = modelHeader(file);
  return !!h && h.readUInt32LE(0) === 0x67676d6c && h.readInt32LE(4) === 8192
    && h.readInt32LE(12) === 1024 && h.readInt32LE(16) === 8 && h.readInt32LE(20) === 24
    && h.readInt32LE(24) === 128 && h.readInt32LE(32) === 512 && h.readInt32LE(36) === 8;
}
