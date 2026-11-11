"use client";

import { useRef, useState } from "react";
import { ImageIcon, X } from "lucide-react";
import type { NoteImage } from "@/lib/note-images";

export function NoteImageAttachments({ leadId, images }: { leadId: string; images: NoteImage[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<NoteImage | null>(null);
  const [failed, setFailed] = useState(false);
  function close() {
    dialog.current?.close();
    setSelected(null);
    setFailed(false);
  }
  return <div className="note-timeline-images">
    {images.map(image => <button type="button" className="note-image-attachment" key={image.id} aria-label={`View ${image.filename}`} aria-haspopup="dialog" onClick={() => {
      setSelected(image); setFailed(false); dialog.current?.showModal();
    }}><span className="note-attachment-icon"><ImageIcon size={18} /></span><span className="note-attachment-name">{image.filename}</span><span className="note-attachment-action">View image</span></button>)}
    <dialog ref={dialog} className="note-image-viewer" aria-label="Note image viewer" onCancel={close} onClose={() => { setSelected(null); setFailed(false); }} onClick={event => {
      if (event.target === event.currentTarget) close();
    }}>
      {selected && <div className="note-image-viewer-content">
        <header><strong title={selected.filename}>{selected.filename}</strong><button type="button" className="button button-secondary" aria-label="Close image viewer" onClick={close} autoFocus><X size={18} /></button></header>
        <div className="note-image-viewer-body">
          {failed ? <div className="note-image-viewer-error" role="alert"><p>Could not load this image. Check your connection and access to this lead.</p><button type="button" className="button button-secondary" onClick={() => setFailed(false)}>Retry</button></div> :
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={selected.id} src={`/api/leads/${leadId}/notes/${selected.id}`} alt={selected.filename} onError={() => setFailed(true)} />}
        </div>
      </div>}
    </dialog>
  </div>;
}
