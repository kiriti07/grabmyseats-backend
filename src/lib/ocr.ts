import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { cropPosterRegion } from "./cropPosterRegion";
import { extractTextFromImageVision, isVisionConfigured } from "./ocrVision";

export interface OcrLine {
  text: string;
  confidence: number;
  height: number;
  // Bounding box in source-image pixels. Populated by both OCR engines so
  // parseListingText.ts's title heuristic can reason about position, not
  // just line height, regardless of which engine produced the line.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrExtraction {
  text: string;
  lines: OcrLine[];
}

// Tesseract workers are expensive to spin up (loads the WASM core and the
// English trained-data model, downloading it on first use), so this app
// keeps one warm worker instead of creating/tearing one down per request.
// No API key / external service needed (unlike Google Cloud Vision) -
// keeps the cost and setup for OCR at zero, which is why it remains the
// fallback engine when Vision isn't configured (see extractTextFromImage).
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", undefined, {
      cachePath: path.join(__dirname, "../../.tesseract-cache"),
    });
  }
  return workerPromise;
}

async function extractTextFromImageTesseract(buffer: Buffer): Promise<OcrExtraction> {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer, {}, { blocks: true });

  // Tesseract's top-level "blocks" are page-layout regions, which for a
  // visually dense ticket screenshot often merge into a single block
  // covering the whole image - useless as a proxy for "biggest text on
  // the page". Lines (block > paragraph > line) are a much finer-grained
  // unit and still carry their own bbox, so line height stands in for
  // font size instead.
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.trim();
        if (!text) continue;
        lines.push({
          text,
          confidence: line.confidence,
          height: line.bbox.y1 - line.bbox.y0,
          x0: line.bbox.x0,
          y0: line.bbox.y0,
          x1: line.bbox.x1,
          y1: line.bbox.y1,
        });
      }
    }
  }

  return { text: data.text, lines };
}

// Google Cloud Vision (DOCUMENT_TEXT_DETECTION) reads real ticket
// screenshots far more reliably than Tesseract - fewer misread icons
// merged into text, better handling of stylized poster art - so it's
// used whenever credentials are configured. Tesseract remains the
// fallback for local dev/CI, which has no Google credentials.
//
// skipPosterCrop bypasses cropPosterRegion - for EVENT/SPORT tickets (see
// POST /api/listings/ocr), which don't fit the movie-poster-thumbnail
// layout that mask is calibrated against; masking a corner of a ticket
// format it was never tuned for risks painting over real content instead
// of poster art.
export async function extractTextFromImage(
  buffer: Buffer,
  options?: { skipPosterCrop?: boolean },
): Promise<OcrExtraction> {
  const source = options?.skipPosterCrop ? buffer : await cropPosterRegion(buffer);

  if (isVisionConfigured()) {
    try {
      return await extractTextFromImageVision(source);
    } catch (err) {
      console.warn("Google Cloud Vision OCR failed, falling back to Tesseract:", err);
    }
  }
  return extractTextFromImageTesseract(source);
}
