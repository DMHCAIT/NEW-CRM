export const MAX_NOTE_IMAGES = 3;
export const MAX_NOTE_IMAGE_BYTES = 5_000_000;
export const NOTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export type NoteImageInput = { filename: string; type: string; data: string };
export type NoteImage = { id: string; filename: string };

export function noteImageError(file: { size: number; type: string }): string | null {
  if (!NOTE_IMAGE_TYPES.includes(file.type)) return "Choose a PNG, JPEG, GIF or WebP image.";
  if (!file.size || file.size > MAX_NOTE_IMAGE_BYTES) return "Each note image must be no larger than 5 MB.";
  return null;
}

export function readNoteImage(file: File): Promise<NoteImageInput> {
  const error = noteImageError(file);
  if (error) return Promise.reject(new Error(error));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read "${file.name}". Please select the image again.`));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) {
        reject(new Error("Could not read the selected image.")); return;
      }
      resolve({ filename: file.name.slice(0, 255) || "pasted-image", type: file.type, data: reader.result.slice(reader.result.indexOf(",") + 1) });
    };
    reader.readAsDataURL(file);
  });
}
