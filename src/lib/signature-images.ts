import { MAX_SIGNATURE_LENGTH, SIGNATURE_LENGTH_ERROR } from "@/lib/email-signature-policy";

export const MAX_SIGNATURE_IMAGE_BYTES = 1024 * 1024;
export const signatureImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export async function preparePastedSignature(html: string, files: File[], upload: (file: File) => Promise<string>) {
  if (!html.trim()) throw new Error("Copy the rendered signature, including its clickable links, then paste it here.");
  if (html.length > MAX_SIGNATURE_LENGTH) throw new Error(SIGNATURE_LENGTH_ERROR);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(parsed.querySelectorAll("img"));
  const replacements = new Map<string, File>();
  const localSources = new Set<string>();
  for (const image of images) {
    const source = (image.getAttribute("src") ?? "").trim();
    if (/^https:\/\//i.test(source)) continue;
    if (/^data:/i.test(source)) {
      if (replacements.has(source)) continue;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(source);
      if (!match) throw new Error("An embedded signature image is unsupported. Use PNG, JPEG, GIF or WebP images.");
      const base64 = match[2].replace(/\s/g, "");
      if (base64.length > Math.ceil(MAX_SIGNATURE_IMAGE_BYTES / 3) * 4)
        throw new Error("Each embedded signature image must be no larger than 1 MB.");
      let decoded: string;
      try { decoded = atob(base64); }
      catch { throw new Error("An embedded signature image could not be decoded. Copy the original signature again."); }
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      replacements.set(source, new File([bytes], "signature-image", { type: match[1].toLowerCase() }));
    } else {
      localSources.add(source);
    }
  }
  const clipboardImages = files.filter(file => signatureImageTypes.includes(file.type));
  if (localSources.size) {
    // Clipboard files have no reliable source mapping; only one distinct local image is unambiguous.
    if (localSources.size !== 1 || clipboardImages.length !== 1)
      throw new Error("The clipboard did not include the local signature images. Copy the rendered signature from its original page, or upload those images separately.");
    replacements.set([...localSources][0], clipboardImages[0]);
  }
  for (const file of replacements.values()) {
    if (!file.size || file.size > MAX_SIGNATURE_IMAGE_BYTES)
      throw new Error("Each signature image must be no larger than 1 MB.");
  }
  // Verify hosted URLs before any uploads and prevent alternate image sources from overriding the replacement.
  for (const image of images) {
    const source = (image.getAttribute("src") ?? "").trim();
    if (!replacements.has(source)) {
      let url: URL;
      try { url = new URL(source); }
      catch { throw new Error("The signature contains an invalid image URL."); }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Hosted signature images must use HTTPS URLs without embedded credentials.");
    }
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
  }
  parsed.querySelectorAll("picture source").forEach(source => source.remove());
  const uploaded = await Promise.all(Array.from(replacements, async ([source, file]) =>
    [source, await upload(file)] as const));
  for (const [source, url] of uploaded) {
    signatureImageHtml(url, "", "");
    for (const image of images) {
      if ((image.getAttribute("src") ?? "").trim() === source) image.setAttribute("src", url);
    }
  }
  return pastedSignatureHtml(parsed.body.innerHTML);
}

export function pastedSignatureHtml(html: string) {
  if (!html.trim()) throw new Error("Copy the rendered signature, including its clickable links, then paste it here.");
  if (html.length > MAX_SIGNATURE_LENGTH) throw new Error(SIGNATURE_LENGTH_ERROR);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const image of parsed.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";
    let url: URL;
    try { url = new URL(source); }
    catch { throw new Error("The copied signature contains a local image. Use an HTTPS-hosted image in the HTML, or upload the image separately."); }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("The copied signature contains an embedded or local image. Use an HTTPS-hosted image in the HTML, or upload the image separately.");
  }
  const fragment = parsed.body.innerHTML.trim();
  if (!fragment) throw new Error("No signature content was found in the clipboard.");
  if (fragment.length > MAX_SIGNATURE_LENGTH) throw new Error(SIGNATURE_LENGTH_ERROR);
  return fragment;
}

export function signatureImageHtml(url: string, link: string, alt: string) {
  const image = new URL(url);
  if (image.protocol !== "https:" || image.username || image.password) throw new Error("Signature images require an HTTPS URL.");
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<img src="${escape(image.href)}" alt="${escape(alt.trim() || "Email signature")}" width="480">`;
  if (!link.trim()) return `<p>${html}</p>`;
  const target = new URL(link.trim());
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) throw new Error("Enter a full http:// or https:// click-through URL.");
  return `<p><a href="${escape(target.href)}">${html}</a></p>`;
}
