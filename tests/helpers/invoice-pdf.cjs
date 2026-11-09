const { PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = require("pdf-lib");

function streamText(stream) {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString();
}

function pdfCommands(document) {
  return document.getPages().map(page => {
    const contents = page.node.Contents();
    return contents instanceof PDFArray
      ? contents.asArray().map(ref => streamText(document.context.lookup(ref))).join("\n")
      : streamText(contents);
  }).join("\n");
}

function pdfText(document) {
  const unicode = hex => Buffer.from(hex, "hex").swap16().toString("utf16le");
  return document.getPages().map(page => {
    const fonts = page.node.Resources().lookup(PDFName.of("Font"));
    const maps = new Map();
    for (const [name, ref] of fonts.entries()) {
      const font = document.context.lookup(ref);
      const cmap = font.lookupMaybe(PDFName.of("ToUnicode"), PDFRawStream);
      if (!cmap) continue;
      const source = streamText(cmap), map = new Map();
      for (const [, block] of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const [, from, to] of block.matchAll(/<(\w+)>\s*<(\w+)>/g)) map.set(from.toUpperCase(), unicode(to));
      }
      for (const [, block] of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const [, first, last, target] of block.matchAll(/<(\w+)>\s*<(\w+)>\s*<(\w+)>/g)) {
          for (let code = parseInt(first, 16); code <= parseInt(last, 16); code++) {
            map.set(code.toString(16).padStart(first.length, "0").toUpperCase(),
              unicode((parseInt(target, 16) + code - parseInt(first, 16)).toString(16).padStart(target.length, "0")));
          }
        }
      }
      maps.set(name.toString(), map);
    }
    const contents = page.node.Contents();
    const source = contents instanceof PDFArray
      ? contents.asArray().map(ref => streamText(document.context.lookup(ref))).join("\n") : streamText(contents);
    return [...source.matchAll(/BT([\s\S]*?)ET/g)].map(([, block]) => {
      const font = block.match(/\/(\S+)\s+[\d.]+\s+Tf/)?.[1];
      const map = maps.get(`/${font}`);
      return [...block.matchAll(/<([\da-f]+)>/gi)].map(([, hex]) =>
        (hex.toUpperCase().match(/.{4}/g) ?? []).map(code => map?.get(code) ?? "").join("")).join("");
    }).join(" ");
  }).join(" ").replace(/\s+/g, " ").trim();
}

module.exports = { pdfCommands, pdfText };
