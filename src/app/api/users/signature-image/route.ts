import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { MAX_SIGNATURE_IMAGE_BYTES, signatureImageTypes } from "@/lib/signature-images";
import { uploadSignatureImage } from "@/lib/server/signature-image-upload";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("users.manage");
    if (user.profile.role !== "super_admin") throw new HttpError(403, "Only Super Admin can upload user signature images.");
    const rawImage = signatureImageTypes.includes(request.headers.get("content-type") ?? "");
    const maxBody = rawImage ? MAX_SIGNATURE_IMAGE_BYTES : Math.ceil(MAX_SIGNATURE_IMAGE_BYTES / 3) * 4 + 1024;
    if (!request.body) throw new HttpError(400, "Choose or paste a signature image.");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBody) {
          await reader.cancel();
          throw new HttpError(413, "Signature images must be no larger than 1 MB.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let bytes: Buffer;
    let type: string;
    if (rawImage) {
      bytes = Buffer.concat(chunks);
      type = request.headers.get("content-type")!;
    } else {
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new HttpError(400, "Invalid signature image upload."); }
      const parsed = z.object({
        type: z.string().refine(value => signatureImageTypes.includes(value)),
        base64: z.string().min(1).max(Math.ceil(MAX_SIGNATURE_IMAGE_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      }).strict().safeParse(input);
      if (!parsed.success) throw new HttpError(400, "Choose a PNG, JPEG, GIF or WebP image no larger than 1 MB.");
      bytes = Buffer.from(parsed.data.base64, "base64");
      type = parsed.data.type;
    }
    const url = await uploadSignatureImage(getSupabaseAdminClient(), bytes, type, user.id);
    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
