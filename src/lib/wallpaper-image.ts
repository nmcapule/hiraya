const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;

export const WALLPAPER_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

type ImageDimensions = { width: number; height: number };
type ImageDecoder = (file: File) => Promise<ImageDimensions>;

function detectedMimeType(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

async function decodeInBrowser(file: File): Promise<ImageDimensions> {
  const bitmap = await createImageBitmap(file);
  try { return { width: bitmap.width, height: bitmap.height }; }
  finally { bitmap.close(); }
}

export async function validateWallpaperImage(file: File, decode: ImageDecoder = decodeInBrowser) {
  if (file.size > MAX_BYTES) throw new Error("Wallpaper images must be no larger than 20 MiB.");
  const mediaType = file.type.split(";", 1)[0].trim().toLowerCase();
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mediaType)) {
    throw new Error("Wallpaper images must be JPEG, PNG, or WebP files.");
  }
  const detected = detectedMimeType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (detected !== mediaType) throw new Error("The wallpaper image contents do not match its file type.");
  let dimensions: ImageDimensions;
  try { dimensions = await decode(file); }
  catch { throw new Error("The wallpaper image could not be decoded."); }
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1) {
    throw new Error("The wallpaper image has invalid dimensions.");
  }
  if (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION || dimensions.width * dimensions.height > MAX_PIXELS) {
    throw new Error("Wallpaper images must be at most 8192 pixels per side and 40 megapixels.");
  }
  return dimensions;
}
