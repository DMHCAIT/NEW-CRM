"use client";

import { useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, X } from "lucide-react";
import { MAX_NOTE_IMAGES, NOTE_IMAGE_TYPES, readNoteImage, type NoteImageInput } from "@/lib/note-images";

export function LeadNoteComposer({ disabled, content, onContentChange: setContent, images, onImagesChange: setImages, onSave }: {
  disabled: boolean;
  content: string;
  onContentChange: (content: string) => void;
  images: NoteImageInput[];
  onImagesChange: (images: NoteImageInput[]) => void;
  onSave: (content: string, images: NoteImageInput[]) => Promise<void>;
}) {
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const locked = disabled || reading || saving;
  async function addImages(files: File[]) {
    if (disabled || working.current || !files.length) return;
    setError("");
    if (images.length + files.length > MAX_NOTE_IMAGES) { setError("Attach up to 3 images per note. Remove an image before adding more."); return; }
    working.current = true; setReading(true);
    try {
      const added = await Promise.all(files.map(readNoteImage));
      setImages([...images, ...added]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not read the selected images."); }
    finally { working.current = false; setReading(false); }
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) for (const item of Array.from(event.clipboardData.items ?? [])) {
      if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); }
    }
    if (!files.length) return;
    event.preventDefault();
    if (locked) return;
    const text = event.clipboardData.getData("text/plain");
    if (text) setContent((content + text).slice(0, 10000));
    void addImages(files);
  }
  return <form className="live-update-form" onPaste={paste} onSubmit={async event => {
    event.preventDefault();
    if (locked || working.current || (!content.trim() && !images.length)) return;
    working.current = true; setSaving(true); setError("");
    try { await onSave(content, images); setContent(""); setImages([]); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save the note. Your draft has been kept."); }
    finally { working.current = false; setSaving(false); }
  }}>
    <label className="form-field">Note<textarea aria-label="Note" disabled={locked} maxLength={10000} rows={5} value={content} placeholder="Write a note, or paste an image here…" onChange={event => setContent(event.target.value)} /></label>
    <div className="note-image-toolbar">
      <input ref={input} className="note-image-file" aria-label="Upload note images" type="file" accept={NOTE_IMAGE_TYPES.join(",")} multiple disabled={locked} onChange={event => {
        const files = Array.from(event.target.files ?? []); event.target.value = ""; void addImages(files);
      }} />
      <button className="button button-secondary" type="button" disabled={locked || images.length >= MAX_NOTE_IMAGES} onClick={() => input.current?.click()}><ImagePlus size={15} />Upload image</button>
      <span className="note-image-paste" tabIndex={locked ? -1 : 0} role="textbox" aria-label="Paste note image" aria-disabled={locked}>Paste with Ctrl+V / Cmd+V</span>
      <small>PNG, JPG, GIF or WebP · 5 MB each · Up to 3 images</small>
    </div>
    {images.length > 0 && <div className="note-image-previews" aria-label="Attached images">{images.map((image, index) => <figure key={index}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:${image.type};base64,${image.data}`} alt={image.filename} />
      <figcaption title={image.filename}>{image.filename}</figcaption>
      <button type="button" disabled={locked} aria-label={`Remove image ${index + 1}`} onClick={() => setImages(images.filter((_, position) => position !== index))}><X size={14} /></button>
    </figure>)}</div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {reading && <p role="status">Reading images…</p>}
    <div className="lead-compose-footer"><span>{content.length.toLocaleString()} / 10,000 characters{images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}` : ""}</span><button className="button button-primary" disabled={locked || (!content.trim() && !images.length)}>{saving || disabled ? "Saving..." : "Add note"}</button></div>
  </form>;
}
