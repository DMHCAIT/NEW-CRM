import { HttpError } from "@/lib/server/auth";
import { MAX_NOTE_IMAGES, MAX_NOTE_IMAGE_BYTES, NOTE_IMAGE_TYPES, type NoteImageInput } from "@/lib/note-images";

export function parseNoteImages(value: unknown): NoteImageInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTE_IMAGES) throw new HttpError(400, "Attach up to 3 images per note.");
  return value.map((image: unknown) => {
    if (!image || typeof image !== "object" || !("filename" in image) || !("type" in image) || !("data" in image)) {
      throw new HttpError(400, "Invalid note image.");
    }
    const { filename, type: declaredType, data } = image;
    if (typeof filename !== "string" || !filename.trim() || filename.length > 255
      || typeof declaredType !== "string" || !NOTE_IMAGE_TYPES.includes(declaredType)
      || typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_NOTE_IMAGE_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new HttpError(400, "Invalid note image. Use PNG, JPEG, GIF or WebP images no larger than 5 MB.");
    }
    const bytes = Buffer.from(data, "base64");
    const type = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR" ? "image/png"
      : bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
        : bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ? "image/gif"
          : bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
    if (!type || bytes.length > MAX_NOTE_IMAGE_BYTES || bytes.toString("base64") !== data || type !== declaredType) throw new HttpError(400, "The image contents do not match a supported image format.");
    return { filename: filename.trim(), type, data };
  });
}
