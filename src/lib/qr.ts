import { Jimp } from "jimp";
import jsQR from "jsqr";

// Decodes any QR code found in the image and returns the raw string as-is -
// deliberately no parsing/validation of its contents (it could be a
// BookMyShow deep link, a plain ticket code, anything). Returns null if
// no QR code is found or the image can't be decoded.
export async function decodeQrCode(buffer: Buffer): Promise<string | null> {
  try {
    const image = await Jimp.read(buffer);
    const { data, width, height } = image.bitmap;
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const result = jsQR(pixels, width, height);
    return result?.data ?? null;
  } catch {
    return null;
  }
}
