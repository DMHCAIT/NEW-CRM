export type LeadImportSheet = {
  id: string;
  filename: string;
  total_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  status: "importing" | "completed" | "deleted";
  created_at: string;
};

export async function createLeadImportPdf(sheet: LeadImportSheet): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.1, 0.19, 0.32);
  const muted = rgb(0.4, 0.46, 0.55);
  const green = rgb(0.08, 0.47, 0.32);
  const amber = rgb(0.62, 0.38, 0.08);
  const blue = rgb(0.15, 0.39, 0.77);
  const pending = sheet.total_rows - sheet.imported_rows - sheet.duplicate_rows;
  const status = sheet.status === "completed" ? "Completed" : sheet.status === "deleted" ? "Deleted" : "Incomplete";
  const statusColor = sheet.status === "completed" ? green : sheet.status === "deleted" ? rgb(0.66, 0.2, 0.2) : amber;
  const filenameLines: string[] = [];
  let filenameImage: Awaited<ReturnType<typeof pdf.embedPng>> | undefined;
  const supported = new Set(font.getCharacterSet());
  if (Array.from(sheet.filename).every(character => supported.has(character.codePointAt(0)!))) {
    let line = "";
    for (const character of Array.from(sheet.filename)) {
      if (font.widthOfTextAtSize(line + character, 12) > 491) { filenameLines.push(line); line = character; }
      else line += character;
    }
    if (line) filenameLines.push(line);
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = 1473;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not render the sheet name in the PDF.");
    context.font = "36px sans-serif";
    let line = "";
    for (const character of Array.from(sheet.filename)) {
      if (context.measureText(line + character).width > canvas.width) { filenameLines.push(line); line = character; }
      else line += character;
    }
    if (line) filenameLines.push(line);
    canvas.height = Math.max(1, filenameLines.length) * 54;
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#1a3052"; context.font = "36px sans-serif";
    filenameLines.forEach((text, index) => context.fillText(text, 0, 39 + index * 54));
    filenameImage = await pdf.embedPng(canvas.toDataURL("image/png"));
    canvas.width = 0; canvas.height = 0;
  }

  const extraHeight = Math.max(0, filenameLines.length - 1) * 18;
  const height = 596 + extraHeight;
  const page = pdf.addPage([595, height]);
  const text = (value: string, x: number, top: number, size = 11, color = navy, strong = false) =>
    page.drawText(value, { x, y: height - top - size, size, font: strong ? bold : font, color });
  const block = (x: number, top: number, width: number, blockHeight: number, color: ReturnType<typeof rgb>) =>
    page.drawRectangle({ x, y: height - top - blockHeight, width, height: blockHeight, color });

  pdf.setTitle(`Lead import summary - ${sheet.filename}`);
  pdf.setAuthor("DMHCA CRM");
  block(0, 0, 595, 102, navy);
  block(0, 0, 595, 4, blue);
  text("DMHCA  /  ADMISSIONS CRM", 36, 22, 9, rgb(0.7, 0.79, 0.9), true);
  text("Lead import summary", 36, 42, 25, rgb(1, 1, 1), true);
  text(new Date(sheet.created_at).toISOString().replace("T", " ").slice(0, 19) + " UTC", 36, 78, 9, rgb(0.76, 0.83, 0.92));
  text("UPLOADED SHEET", 36, 122, 9, muted, true);
  if (filenameImage) {
    page.drawImage(filenameImage, { x: 36, y: height - 160 - extraHeight, width: 491, height: 18 + extraHeight });
  } else {
    filenameLines.forEach((line, index) => text(line, 36, 142 + index * 18, 12, navy, true));
  }

  const sectionTop = 180 + extraHeight;
  const metrics = [
    { label: "Total leads in sheet", value: sheet.total_rows, color: blue, background: rgb(0.94, 0.96, 1) },
    { label: "Leads imported", value: sheet.imported_rows, color: green, background: rgb(0.92, 0.97, 0.94) },
    { label: "Duplicates skipped", value: sheet.duplicate_rows, color: amber, background: rgb(1, 0.96, 0.89) },
  ];
  metrics.forEach((metric, index) => {
    const x = 36 + index * 178;
    block(x, sectionTop, 167, 88, metric.background);
    text(metric.label, x + 14, sectionTop + 14, 10, muted);
    text(metric.value.toLocaleString("en-US"), x + 14, sectionTop + 36, 27, metric.color, true);
  });
  text("IMPORT RESULT", 36, sectionTop + 112, 9, muted, true);
  const badgeWidth = bold.widthOfTextAtSize(status, 10) + 22;
  block(559 - badgeWidth, sectionTop + 106, badgeWidth, 24,
    sheet.status === "completed" ? rgb(0.92, 0.97, 0.94) : sheet.status === "deleted" ? rgb(1, 0.94, 0.94) : rgb(1, 0.96, 0.89));
  text(status, 570 - badgeWidth, sectionTop + 112, 10, statusColor, true);
  block(36, sectionTop + 144, 523, 8, rgb(0.91, 0.93, 0.96));
  let segmentX = 36;
  if (sheet.total_rows > 0) {
    for (const metric of metrics.slice(1)) {
      const width = 523 * metric.value / sheet.total_rows;
      if (width > 0) block(segmentX, sectionTop + 144, width, 8, metric.color);
      segmentX += width;
    }
  }
  text("Imported", 36, sectionTop + 164, 10, green);
  text("Duplicates", 116, sectionTop + 164, 10, amber);
  text("Not processed", 36, sectionTop + 195, 11, muted);
  const pendingLabel = pending.toLocaleString("en-US");
  text(pendingLabel, 559 - bold.widthOfTextAtSize(pendingLabel, 13), sectionTop + 193, 13, navy, true);
  block(36, sectionTop + 232, 523, 70, rgb(0.96, 0.97, 0.99));
  text("ABOUT THIS IMPORT", 50, sectionTop + 245, 9, muted, true);
  text("Duplicates include repeated sheet rows and existing CRM matches.", 50, sectionTop + 263, 10, muted);
  text("Only new leads belong to this sheet. Existing leads are unchanged.", 50, sectionTop + 279, 10, muted);
  text(`Import ID: ${sheet.id}`, 36, height - 64, 8, muted);
  text("DMHCA CRM", 36, height - 40, 9, muted, true);
  text("1 / 1", 538, height - 40, 9, muted);
  return pdf.save();
}

export async function downloadLeadImportPdf(sheet: LeadImportSheet) {
  const bytes = await createLeadImportPdf(sheet);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sheet.filename.replace(/\.[^.]+$/, "")}-import-summary.pdf`;
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
