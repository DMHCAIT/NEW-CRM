"use client";

import { useRef, useState } from "react";
import { uploadSignatureFile } from "@/lib/signature-image-client";
import { MAX_SIGNATURE_IMAGE_BYTES, preparePastedSignature, signatureImageHtml, signatureImageTypes } from "@/lib/signature-images";

export function SignatureImageInput({ disabled, onInsert, onBusyChange }: {
  disabled: boolean; onInsert: (html: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [link, setLink] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const uploading = useRef(false);
  async function paste(html: string, files: File[]) {
    uploading.current = true; onBusyChange(true); setError(""); setMessage("");
    try {
      onInsert(await preparePastedSignature(html, files, uploadSignatureFile));
      setMessage("Signature pasted with its images and existing links. Save the user to keep this change.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not paste the signature."); }
    finally { uploading.current = false; onBusyChange(false); }
  }
  async function insert(file: File) {
    if (disabled || uploading.current) return;
    setError(""); setMessage("");
    if (!signatureImageTypes.includes(file.type) || !file.size || file.size > MAX_SIGNATURE_IMAGE_BYTES) {
      setError("Choose or paste a PNG, JPEG, GIF or WebP image no larger than 1 MB."); return;
    }
    try { signatureImageHtml("https://example.test/image.png", link, alt); }
    catch { setError("Enter a full http:// or https:// click-through URL, or leave it blank."); return; }
    uploading.current = true; onBusyChange(true);
    try {
      onInsert(signatureImageHtml(await uploadSignatureFile(file), link, alt));
      setMessage("Image added to the signature. Save the user to keep this change.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add the signature image."); }
    finally { uploading.current = false; onBusyChange(false); }
  }
  return <div className="signature-image-input">
    <strong>Paste your rendered signature or upload an image</strong>
    <div className="form-grid">
      <label className="form-field">Link for a plain image upload (optional)<input type="url" disabled={disabled} value={link} placeholder="https://dmhca.in" onChange={event => setLink(event.target.value)} /><small>Not needed for a copied HTML signature: its existing links are preserved automatically.</small></label>
      <label className="form-field">Image description (optional)<input maxLength={150} disabled={disabled} value={alt} placeholder="DMHCA admissions team" onChange={event => setAlt(event.target.value)} /></label>
    </div>
    <div className="signature-image-paste" role="textbox" aria-label="Paste signature image" aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onPaste={event => {
      if (disabled || uploading.current) return;
      event.preventDefault();
      const html = event.clipboardData.getData("text/html");
      if (html.trim()) {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) for (const item of Array.from(event.clipboardData.items)) {
          if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); }
        }
        void paste(html, files);
        return;
      }
      const file = Array.from(event.clipboardData.items).find(item => item.kind === "file")?.getAsFile() ?? event.clipboardData.files[0];
      if (file) void insert(file);
      else { setError("No formatted signature or image found. Select and copy the rendered HTML signature, or use Upload signature image."); setMessage(""); }
    }}>Click here, then press Ctrl+V (or Cmd+V) to paste your rendered signature with its clickable links</div>
    <label className="form-field">Upload signature image<input disabled={disabled} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void insert(file);
    }} /></label>
    <small>Copy the rendered HTML signature rather than a screenshot to keep its existing clickable links and formatting. Embedded images are uploaded automatically (maximum 1 MB each). Plain image files do not contain HTML links. Uploaded images are stored at a public URL; do not upload private information. Pasting appends to the HTML above. Email clients may require recipients to enable images.</small>
    {disabled && uploading.current && <p role="status">Uploading signature image...</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </div>;
}
