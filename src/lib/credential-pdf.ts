export async function createCredentialPdf(email: string, password: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  const lines = [`Email: ${email}`, `Password: ${password}`];
  const wrapped = lines.flatMap((line) => {
    const characters = Array.from(line);
    const result = [];
    for (let index = 0; index < characters.length; index += 60) result.push(characters.slice(index, index + 60).join(""));
    return result;
  });
  const page = pdf.addPage([595, 842]);
  const supportedCharacters = new Set(font.getCharacterSet());
  if (wrapped.every((line) => Array.from(line).every((character) => supportedCharacters.has(character.codePointAt(0)!)))) {
    wrapped.forEach((line, index) => page.drawText(line, { x: 40, y: 790 - index * 20, size: 12, font }));
  } else {
    // Browser fonts preserve Unicode credentials unsupported by PDF's built-in fonts.
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = (wrapped.length + 1) * 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not generate the credential PDF in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "24px monospace";
    context.fillStyle = "#000000";
    wrapped.forEach((line, index) => context.fillText(line, 0, (index + 1) * 48));
    const image = await pdf.embedPng(canvas.toDataURL("image/png"));
    page.drawImage(image, { x: 40, y: 802 - canvas.height * 0.32, width: 512, height: canvas.height * 0.32 });
    canvas.width = 0; canvas.height = 0;
  }
  return pdf.save();
}

export function downloadCredentialPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "user-credentials.pdf";
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
