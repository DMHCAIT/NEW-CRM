"use client";

import { apiRequest } from "@/lib/crm-data";
import { MAX_SIGNATURE_IMAGE_BYTES, signatureImageTypes } from "@/lib/signature-images";

export async function uploadSignatureFile(file: File) {
  if (!signatureImageTypes.includes(file.type) || !file.size || file.size > MAX_SIGNATURE_IMAGE_BYTES)
    throw new Error("Choose a PNG, JPEG, GIF or WebP signature image no larger than 1 MB.");
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("Could not read the image."));
    reader.onerror = () => reject(new Error("Could not read the image. Please try uploading it again."));
    reader.onabort = () => reject(new Error("Image reading was cancelled."));
    reader.readAsDataURL(file);
  });
  const result = await apiRequest<{ url: string }>("/api/users/signature-image", { body: { type: file.type, base64 } });
  return result.url;
}
