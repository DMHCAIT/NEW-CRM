"use client";

import { apiRequest } from "@/lib/crm-data";
import { MAX_SIGNATURE_IMAGE_BYTES, signatureImageTypes } from "@/lib/signature-images";

export async function uploadSignatureFile(file: File) {
  if (!signatureImageTypes.includes(file.type) || !file.size || file.size > MAX_SIGNATURE_IMAGE_BYTES)
    throw new Error("Choose a PNG, JPEG, GIF or WebP signature image no larger than 1 MB.");
  const result = await apiRequest<{ url: string }>("/api/users/signature-image", { body: file });
  return result.url;
}
