/**
 * OCR for text that only exists as pixels: images, and PDF pages that are
 * pictures of slides or scans. tesseract.js runs the Tesseract engine as
 * WebAssembly in worker threads; the English model ships in
 * @tesseract.js-data/eng, so nothing is downloaded at run time.
 *
 * A session starts its workers on first use and must be closed, or the
 * worker threads keep the process alive.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Recognised text below this mean word confidence (0-100) is noise: photos, textures, icons. */
export const MIN_CONFIDENCE = 50;
/** Images smaller than this many pixels are icons and bullets, not text. */
export const MIN_PIXELS = 20_000;
const MAX_WORKERS = 2;

type TesseractWorker = {
  recognize(image: Uint8Array): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
};

/** Raw pixels as pdf.js decodes them: kind 1 is 1 bit grey, 2 is RGB, 3 is RGBA. */
export type RawImage = { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray };

export class OcrSession {
  #idle: TesseractWorker[] = [];
  #all: Promise<TesseractWorker>[] = [];
  #waiting: ((worker: TesseractWorker) => void)[] = [];

  /** The text in an encoded image file (PNG, JPEG, GIF, BMP, TIFF, WebP), or "" when there is none worth keeping. */
  async recognize(image: Uint8Array): Promise<string> {
    const worker = await this.#acquire();
    try {
      const { data } = await worker.recognize(image);
      return data.confidence >= MIN_CONFIDENCE ? data.text.trim() : "";
    } catch {
      return "";
    } finally {
      this.#release(worker);
    }
  }

  /** The text in decoded pixels; tiny images are skipped. */
  recognizeRaw(image: RawImage): Promise<string> {
    if (image.width * image.height < MIN_PIXELS) return Promise.resolve("");
    const bitmap = toBmp(image);
    return bitmap ? this.recognize(bitmap) : Promise.resolve("");
  }

  async close(): Promise<void> {
    const workers = await Promise.allSettled(this.#all);
    this.#all = [];
    this.#idle = [];
    await Promise.allSettled(workers.map((w) => (w.status === "fulfilled" ? w.value.terminate() : undefined)));
  }

  async #acquire(): Promise<TesseractWorker> {
    const idle = this.#idle.pop();
    if (idle) return idle;
    if (this.#all.length < MAX_WORKERS) {
      const started = startWorker();
      this.#all.push(started);
      return started;
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(worker: TesseractWorker): void {
    const next = this.#waiting.shift();
    if (next) next(worker);
    else this.#idle.push(worker);
  }
}

async function startWorker(): Promise<TesseractWorker> {
  const tesseract = require("tesseract.js") as {
    createWorker(lang: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
  };
  const eng = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
  return tesseract.createWorker("eng", 1, {
    langPath: eng.langPath,
    gzip: eng.gzip,
    cacheMethod: "none",
    logger: () => {},
    errorHandler: () => {},
  });
}

/** Decoded pixels as an uncompressed 24 bit BMP, the simplest format Tesseract reads. */
export function toBmp({ width, height, kind, data }: RawImage): Uint8Array | null {
  if (!(width > 0 && height > 0)) return null;
  const rowBytes = (width * 3 + 3) & ~3;
  const out = Buffer.alloc(54 + rowBytes * height);
  out.write("BM", 0, "latin1");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowBytes * height, 34);
  const packedRow = Math.ceil(width / 8);
  const channels = kind === 3 ? 4 : kind === 2 ? 3 : 0;
  if (channels === 0 && kind !== 1) return null;
  const needed = channels === 0 ? packedRow * height : width * height * channels;
  if (data.length < needed) return null;
  for (let y = 0; y < height; y++) {
    // BMP rows run bottom to top, pixels as blue, green, red.
    let at = 54 + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++, at += 3) {
      if (channels === 0) {
        const value = (data[y * packedRow + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
        out[at] = out[at + 1] = out[at + 2] = value;
      } else {
        const from = (y * width + x) * channels;
        // Transparent pixels go over white paper, as on a printed page.
        const alpha = channels === 4 ? data[from + 3]! / 255 : 1;
        const over = (value: number) => Math.round(value * alpha + 255 * (1 - alpha));
        out[at] = over(data[from + 2]!);
        out[at + 1] = over(data[from + 1]!);
        out[at + 2] = over(data[from]!);
      }
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}
