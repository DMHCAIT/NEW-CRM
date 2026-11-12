import type { PDFDocument as PdfDocument, PDFPage, PDFFont, RGB } from "pdf-lib";

const publicUrl = "https://www.ibmpcrm.xyz/";
const pageWidth = 595;
const pageHeight = 842;

function wrap(value: string, limit: number) {
  const characters = Array.from(value);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += limit) {
    lines.push(characters.slice(index, index + limit).join(""));
  }
  return lines.length ? lines : [""];
}

function safeFilename(name: string) {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return `${cleaned || "user"}-user-details.pdf`;
}

async function drawValue(
  pdf: PdfDocument,
  page: PDFPage,
  font: PDFFont,
  value: string,
  x: number,
  y: number,
  size: number,
  color: RGB,
) {
  const supportedCharacters = new Set(font.getCharacterSet());
  if (Array.from(value).every(character => supportedCharacters.has(character.codePointAt(0)!))) {
    page.drawText(value, { x, y, size, font, color });
    return;
  }

  const canvas = document.createElement("canvas");
  const scale = 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not generate the credential PDF in this browser.");
  context.font = `${size * scale}px Arial, sans-serif`;
  canvas.width = Math.ceil(context.measureText(value).width + size * scale);
  canvas.height = size * scale * 2;
  context.font = `${size * scale}px Arial, sans-serif`;
  context.textBaseline = "middle";
  context.fillStyle = `rgb(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)})`;
  context.fillText(value, size * scale / 2, canvas.height / 2);
  const image = await pdf.embedPng(canvas.toDataURL("image/png"));
  page.drawImage(image, {
    x,
    y: y - size * 0.55,
    width: canvas.width / scale,
    height: canvas.height / scale,
  });
  canvas.width = 0;
  canvas.height = 0;
}

export async function createCredentialPdf(name: string, email: string, password: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([pageWidth, pageHeight]);
  const navy = rgb(0.055, 0.12, 0.23);
  const blue = rgb(0.12, 0.39, 0.73);
  const ink = rgb(0.11, 0.17, 0.25);
  const muted = rgb(0.39, 0.46, 0.55);
  const pale = rgb(0.95, 0.97, 0.99);
  const border = rgb(0.87, 0.90, 0.94);
  const white = rgb(1, 1, 1);
  const passwordLines = wrap(password, 58);

  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: pale });
  page.drawRectangle({ x: 0, y: 635, width: pageWidth, height: 207, color: navy });
  page.drawRectangle({ x: 0, y: 635, width: 7, height: 207, color: blue });
  page.drawCircle({ x: 545, y: 785, size: 78, color: rgb(0.09, 0.19, 0.33) });
  page.drawText("IBMP CRM", { x: 42, y: 793, size: 17, font: bold, color: white });
  page.drawText("ACCOUNT ACCESS", { x: 42, y: 770, size: 8, font: bold, color: rgb(0.62, 0.76, 0.92) });
  page.drawText("Welcome to your workspace", { x: 42, y: 721, size: 23, font: bold, color: white });
  page.drawText("Your account details are ready. Keep this document private.", {
    x: 42, y: 698, size: 10, font: regular, color: rgb(0.82, 0.87, 0.94),
  });

  page.drawRectangle({ x: 35, y: 247, width: 525, height: 361, color: white, borderColor: border, borderWidth: 1 });
  page.drawRectangle({ x: 35, y: 607, width: 525, height: 1.5, color: blue });
  page.drawText("USER DETAILS", { x: 58, y: 578, size: 9, font: bold, color: blue });

  page.drawText("NAME", { x: 58, y: 548, size: 8, font: bold, color: muted });
  const nameLines = wrap(name, 70);
  for (let index = 0; index < nameLines.length; index++) {
    await drawValue(pdf, page, bold, nameLines[index], 58, 526 - index * 13, 13, ink);
  }

  page.drawText("EMAIL ADDRESS", { x: 58, y: 493, size: 8, font: bold, color: muted });
  const emailLines = wrap(email, 78);
  for (let index = 0; index < emailLines.length; index++) {
    await drawValue(pdf, page, regular, emailLines[index], 58, 471 - index * 14, 10, ink);
  }

  page.drawRectangle({ x: 52, y: 349, width: 491, height: 72, color: pale });
  page.drawText("PASSWORD", { x: 67, y: 402, size: 8, font: bold, color: muted });
  for (let index = 0; index < passwordLines.length; index++) {
    await drawValue(pdf, page, regular, passwordLines[index], 67, 382 - index * 13, 9, ink);
  }

  page.drawText("PUBLIC CRM URL", { x: 58, y: 322, size: 8, font: bold, color: muted });
  page.drawRectangle({ x: 52, y: 271, width: 491, height: 37, color: rgb(0.92, 0.96, 1) });
  await drawValue(pdf, page, bold, publicUrl, 67, 284, 10, blue);

  page.drawRectangle({ x: 35, y: 116, width: 525, height: 96, color: rgb(1, 0.97, 0.90) });
  page.drawRectangle({ x: 35, y: 116, width: 3, height: 96, color: rgb(0.89, 0.57, 0.14) });
  page.drawText("KEEP YOUR ACCOUNT SECURE", { x: 53, y: 186, size: 9, font: bold, color: rgb(0.52, 0.32, 0.08) });
  page.drawText("This PDF contains a plaintext password. Share it only through a secure channel,",
    { x: 53, y: 164, size: 9, font: regular, color: ink });
  page.drawText("and delete your copy after sharing. Never post credentials publicly.",
    { x: 53, y: 149, size: 9, font: regular, color: ink });
  page.drawText("IBMP CRM  |  PRIVATE ACCOUNT INFORMATION", { x: 42, y: 54, size: 8, font: bold, color: muted });

  return pdf.save();
}

export function credentialPdfFilename(name: string) {
  return safeFilename(name);
}

export function downloadCredentialPdf(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = credentialPdfFilename(name);
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
