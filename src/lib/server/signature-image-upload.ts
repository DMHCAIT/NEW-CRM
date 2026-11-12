import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { MAX_SIGNATURE_IMAGE_BYTES } from "@/lib/signature-images";

export const signatureImageBucket = "email-signatures";
let bucketInitialization: Promise<void> | null = null;

export function signatureImageFormat(bytes: Buffer) {
  if (bytes.length > MAX_SIGNATURE_IMAGE_BYTES) throw new HttpError(400, "Signature images must be no larger than 1 MB.");
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR")
    return { type: "image/png", extension: "png" };
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { type: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return { type: "image/gif", extension: "gif" };
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return { type: "image/webp", extension: "webp" };
  throw new HttpError(400, "Choose a PNG, JPEG, GIF or WebP image. SVG and other file types are not supported.");
}

export async function uploadSignatureImage(admin: SupabaseClient, bytes: Buffer, declaredType: string, actorId: string) {
  const format = signatureImageFormat(bytes);
  if (format.type !== declaredType) throw new HttpError(400, "The image contents do not match its file type.");
  if (!bucketInitialization) {
    bucketInitialization = (async () => {
      const { data: bucket, error: bucketError } = await admin.storage.getBucket(signatureImageBucket);
      if (bucketError) {
        if (!["404", "400"].includes(String(bucketError.statusCode)) || !/not found/i.test(bucketError.message))
          throw new HttpError(503, "Signature image storage could not be checked. Contact your administrator.");
        const { error: createError } = await admin.storage.createBucket(signatureImageBucket, {
          public: true, fileSizeLimit: MAX_SIGNATURE_IMAGE_BYTES, allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
        });
        if (createError) {
          const { data: existing, error } = await admin.storage.getBucket(signatureImageBucket);
          if (error || !existing?.public) throw new HttpError(503, "Signature image storage could not be initialized. Contact your administrator.");
        }
      } else if (!bucket?.public) {
        throw new HttpError(503, "The email-signatures storage bucket must allow public image reads for email recipients.");
      }
    })();
  }
  try { await bucketInitialization; }
  catch (error) {
    bucketInitialization = null;
    throw error;
  }
  const path = `${actorId}/${randomUUID()}.${format.extension}`;
  const { error } = await admin.storage.from(signatureImageBucket).upload(path, bytes, {
    contentType: format.type, cacheControl: "31536000", upsert: false,
  });
  if (error) throw new HttpError(503, "The signature image could not be uploaded. Check storage availability and try again.");
  const { data } = admin.storage.from(signatureImageBucket).getPublicUrl(path);
  return data.publicUrl;
}
