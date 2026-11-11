const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const root = path.join(__dirname, "..");
const image = { filename: "admission.png", type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OXsAAAAASUVORK5CYII=" };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const auth = {
  HttpError, readJson: request => request.json(),
  requireString(value, label, max) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${label} is required.`);
    return value.trim();
  },
  jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
};
const validation = { uuid: value => value, dbError: error => { if (error) throw new HttpError(400, error.message); } };
function load(file, overrides = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("exports", "require", source)(exports, name => {
    if (name in overrides) return overrides[name];
    if (name === "@/lib/server/auth") return auth;
    if (name === "@/lib/live-leads") return validation;
    if (name === "@/lib/server/login") return { checkOrigin() {} };
    if (name === "@/lib/server/operational-gmail" || name === "@/lib/supabase/server" || name === "@/lib/server/email-signature") return {};
    if (name.startsWith("@/")) return load(name.replace("@/", "src\\").replaceAll("/", "\\") + ".ts", overrides);
    return require(name);
  });
  return exports;
}
const noteImages = load("src\\lib\\note-images.ts");
const { parseNoteImages } = load("src\\lib\\server\\note-images.ts");

test("note images validate exact formats, base64, count and the 5 MB size boundary", () => {
  assert.deepEqual(parseNoteImages([image]), [image]);
  assert.equal(noteImages.noteImageError({ type: "image/png", size: 5000000 }), null);
  assert.match(noteImages.noteImageError({ type: "image/png", size: 5000001 }), /5 MB/);
  const large = Buffer.alloc(5000000);
  Buffer.from(image.data, "base64").copy(large);
  assert.equal(parseNoteImages([{ ...image, data: large.toString("base64") }]).length, 1);
  assert.equal(parseNoteImages(undefined).length, 0);
  for (const value of [
    null, {}, [image, image, image, image], [{ ...image, data: "<svg>unsafe</svg>" }],
    [{ ...image, data: Buffer.from("<svg>unsafe</svg>").toString("base64") }],
    [{ ...image, type: "image/jpeg" }], [{ ...image, filename: "" }],
    [{ ...image, data: Buffer.alloc(5000001).toString("base64") }],
  ]) assert.throws(() => parseNoteImages(value), HttpError);
});

test("image notes use one atomic RPC, allow images without text and retain text-only behavior", async () => {
  const writes = [];
  const route = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/crm-data": { fetchLead: async () => ({ isArchived: false }) },
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.edit");
      return { user: { id: "owner" }, supabase: {
        rpc: async (name, args) => { writes.push({ name, args }); return { error: null }; },
        from: table => ({ insert: async value => { writes.push({ table, value }); return { error: null }; } }),
      } };
    } },
  });
  const send = body => route.POST(new Request("http://crm.test/api/leads/lead/actions", { method: "POST", body: JSON.stringify({ action: "note", ...body }) }), { params: Promise.resolve({ id: "lead" }) });
  assert.equal((await send({ content: "", images: [image] })).status, 200);
  assert.deepEqual(writes.shift(), { name: "add_live_lead_note", args: { lead_id: "lead", note_content: "", images_json: [image] } });
  assert.equal((await send({ content: " Plain note ", images: [] })).status, 200);
  assert.deepEqual(writes.shift(), { table: "notes", value: { lead_id: "lead", user_id: "owner", content: "Plain note" } });
  assert.equal((await send({ content: "", images: [] })).status, 400);
  assert.equal((await send({ content: "Invalid image", images: [{ ...image, type: "image/svg+xml" }] })).status, 400);
  assert.equal(writes.length, 0);
});

test("note image downloads require lead view permission, lead scope and a matching image relationship", async () => {
  for (const scenario of ["success", "denied", "hidden", "archived", "missing", "failure"]) {
    const filters = [];
    const route = load("src\\app\\api\\leads\\[id]\\notes\\[imageId]\\route.ts", {
      "@/lib/crm-data": { fetchLead: async () => scenario === "hidden" ? null : { isArchived: scenario === "archived" } },
      "@/lib/server/auth": { ...auth, requireUser: async permission => {
        assert.equal(permission, "leads.view");
        if (scenario === "denied") throw new HttpError(403, "Denied");
        const query = {
          select: () => query,
          eq: (column, value) => { filters.push([column, value]); return query; },
          maybeSingle: async () => ({
            data: scenario === "missing" ? null : { mime_type: "image/png", image_data: "\\x" + Buffer.from(image.data, "base64").toString("hex") },
            error: scenario === "failure" ? { message: "Read failed" } : null,
          }),
        };
        return { supabase: { from: table => { assert.equal(table, "note_images"); return query; } } };
      } },
    });
    const response = await route.GET(new Request("http://crm.test/image"), { params: Promise.resolve({ id: "lead", imageId: "image" }) });
    assert.equal(response.status, scenario === "success" ? 200 : scenario === "denied" ? 403 : scenario === "failure" ? 400 : 404);
    if (scenario === "success") {
      assert.deepEqual(filters, [["id", "image"], ["note.lead_id", "lead"]]);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(image.data, "base64"));
    }
  }
});

function elements(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
function composer({ fail = false, disabled = false } = {}) {
  const states = [], refs = [], saves = [];
  let stateIndex = 0, refIndex = 0, content = "", images = [];
  const Component = load("src\\components\\lead-note-composer.tsx", {
    react: {
      ...React,
      useState(initial) {
        const key = stateIndex++;
        if (!(key in states)) states[key] = initial;
        return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
      },
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
    },
    "@/lib/note-images": { ...noteImages, readNoteImage: async file => {
      const error = noteImages.noteImageError(file); if (error) throw new Error(error);
      return { ...image, filename: file.name };
    } },
  }).LeadNoteComposer;
  return {
    saves,
    render() {
      stateIndex = 0; refIndex = 0;
      return Component({ disabled, content, onContentChange: value => { content = value; }, images, onImagesChange: value => { images = value; }, onSave: async (text, images) => {
        if (fail) throw new Error("Save failed; retry.");
        saves.push({ text, images });
      } });
    },
  };
}
const file = { name: "admission.png", type: "image/png", size: 200 };

test("note composer uploads, previews, removes and saves image-only notes", async () => {
  const ui = composer();
  let tree = ui.render();
  assert.match(renderToStaticMarkup(tree), /Upload image|Paste with Ctrl/);
  assert.equal(elements(tree).find(node => node.type === "button" && node.props.children === "Add note").props.disabled, true);
  elements(tree).find(node => node.type === "input").props.onChange({ target: { files: [file], value: "image" } });
  await new Promise(setImmediate);
  tree = ui.render();
  assert.match(renderToStaticMarkup(tree), /Attached images/);
  assert.equal(elements(tree).find(node => node.type === "img").props.src, `data:image/png;base64,${image.data}`);
  elements(tree).find(node => node.props?.["aria-label"] === "Remove image 1").props.onClick();
  assert.doesNotMatch(renderToStaticMarkup(ui.render()), /Attached images/);
  elements(ui.render()).find(node => node.type === "input").props.onChange({ target: { files: [file], value: "" } });
  await new Promise(setImmediate);
  await ui.render().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(ui.saves, [{ text: "", images: [image] }]);
  assert.doesNotMatch(renderToStaticMarkup(ui.render()), /Attached images/);
});

test("note composer pastes images, preserves regular text paste, caps attachments and keeps failed drafts", async () => {
  const ui = composer({ fail: true });
  let prevented = false;
  const paste = files => ({ preventDefault() { prevented = true; }, clipboardData: { files, getData: () => "" } });
  ui.render().props.onPaste(paste([]));
  assert.equal(prevented, false);
  ui.render().props.onPaste(paste([file]));
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  elements(ui.render()).find(node => node.type === "textarea").props.onChange({ target: { value: "Keep my draft" } });
  await ui.render().props.onSubmit({ preventDefault() {} });
  let html = renderToStaticMarkup(ui.render());
  assert.match(html, /Save failed; retry/);
  assert.match(html, /Keep my draft/);
  assert.match(html, /Attached images/);
  ui.render().props.onPaste(paste([file, file, file]));
  html = renderToStaticMarkup(ui.render());
  assert.match(html, /up to 3 images/);
  assert.equal(elements(ui.render()).filter(node => node.type === "img").length, 1);
  const locked = composer({ disabled: true });
  assert.equal(elements(locked.render()).find(node => node.type === "input").props.disabled, true);
  locked.render().props.onPaste(paste([file]));
  await new Promise(setImmediate);
  assert.doesNotMatch(renderToStaticMarkup(locked.render()), /Attached images/);
});

test("timeline attachments load no image until clicked, show a same-page modal and support close and retry", () => {
  const states = [], reference = { current: { showModal() { opened++; }, close() { closed++; } } };
  let stateIndex = 0, opened = 0, closed = 0;
  const Component = load("src\\components\\note-image-attachments.tsx", {
    react: { ...React,
      useRef: () => reference,
      useState(initial) {
        const key = stateIndex++;
        if (!(key in states)) states[key] = initial;
        return [states[key], value => { states[key] = value; }];
      },
    },
  }).NoteImageAttachments;
  const render = () => { stateIndex = 0; return Component({ leadId: "lead", images: [{ id: "image", filename: "admission.png" }] }); };
  let tree = render();
  assert.doesNotMatch(renderToStaticMarkup(tree), /<img|target="_blank"|href=/);
  const trigger = elements(tree).find(node => node.props?.["aria-label"] === "View admission.png");
  assert.equal(trigger.props["aria-haspopup"], "dialog");
  trigger.props.onClick();
  assert.equal(opened, 1);
  tree = render();
  assert.equal(elements(tree).find(node => node.type === "img").props.src, "/api/leads/lead/notes/image");
  elements(tree).find(node => node.type === "img").props.onError();
  tree = render();
  assert.match(renderToStaticMarkup(tree), /Could not load this image/);
  elements(tree).find(node => node.type === "button" && node.props.children === "Retry").props.onClick();
  assert.ok(elements(render()).some(node => node.type === "img"));
  elements(render()).find(node => node.props?.["aria-label"] === "Close image viewer").props.onClick();
  assert.equal(closed, 1);
  assert.doesNotMatch(renderToStaticMarkup(render()), /<img/);
  trigger.props.onClick();
  elements(render()).find(node => node.type === "dialog").props.onCancel();
  assert.equal(closed, 2);
  trigger.props.onClick();
  const dialog = elements(render()).find(node => node.type === "dialog");
  const target = {};
  dialog.props.onClick({ target, currentTarget: target });
  assert.equal(closed, 3);
});

test("image preview stays centered and contains images when resizing across desktop, tablet and mobile", async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    let stateIndex = 0;
    const selected = { id: "image", filename: "long-image-filename-".repeat(20) + ".png" };
    const Component = load("src\\components\\note-image-attachments.tsx", {
      react: { ...React, useRef: () => ({ current: null }), useState: () => [stateIndex++ === 0 ? selected : false, () => {}] },
    }).NoteImageAttachments;
    const markup = renderToStaticMarkup(Component({ leadId: "lead", images: [selected] }));
    const preflight = readFileSync(require.resolve("tailwindcss/lib/css/preflight.css"), "utf8");
    const globals = readFileSync(path.join(root, "src\\app\\globals.css"), "utf8").replace(/@tailwind \w+;/g, "");
    const css = readFileSync(path.join(root, "src\\app\\leads\\leads.css"), "utf8");
    const page = await browser.newPage();
    await page.setContent(`<style>${preflight}\n${globals}\n${css}</style>${markup}`);
    await page.locator("dialog").evaluate(dialog => dialog.showModal());
    for (const [width, height] of [[1920, 1080], [1236, 752], [768, 1024], [390, 844], [320, 568], [844, 390], [568, 240]]) {
      await page.setViewportSize({ width, height });
      for (const [imageWidth, imageHeight] of [[1600, 900], [900, 1600], [80, 80]]) {
        const layout = await page.evaluate(async ({ imageWidth, imageHeight }) => {
          const img = document.querySelector(".note-image-viewer-body img");
          const canvas = document.createElement("canvas");
          canvas.width = imageWidth; canvas.height = imageHeight;
          img.src = canvas.toDataURL("image/png");
          await img.decode();
          const rect = selector => {
            const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
            return { x, y, width, height, right, bottom };
          };
          const dialog = document.querySelector("dialog");
          const body = document.querySelector(".note-image-viewer-body");
          return {
            dialog: rect("dialog"), body: rect(".note-image-viewer-body"), image: rect("dialog img"),
            close: rect('[aria-label="Close image viewer"]'), fit: getComputedStyle(img).objectFit,
            overflow: dialog.scrollHeight > dialog.clientHeight || body.scrollHeight > body.clientHeight || body.scrollWidth > body.clientWidth,
          };
        }, { imageWidth, imageHeight });
        const context = `${width}x${height}, image ${imageWidth}x${imageHeight}`;
        assert.ok(layout.dialog.width <= 640, context);
        assert.ok(layout.dialog.height <= Math.min(520, height * 0.7) + 1, context);
        assert.ok(Math.abs(layout.dialog.x - (width - layout.dialog.width) / 2) <= 1, context);
        assert.ok(Math.abs(layout.dialog.y - (height - layout.dialog.height) / 2) <= 1, context);
        assert.ok(layout.dialog.x >= 16 && layout.dialog.y >= 16, context);
        assert.ok(layout.dialog.right <= width - 16 && layout.dialog.bottom <= height - 16, context);
        assert.ok(layout.close.x >= layout.dialog.x && layout.close.right <= layout.dialog.right, context);
        assert.ok(layout.close.y >= layout.dialog.y && layout.close.bottom <= layout.dialog.bottom, context);
        assert.ok(layout.image.width > 0 && layout.image.height > 0, context);
        assert.ok(layout.image.x >= layout.body.x && layout.image.right <= layout.body.right, context);
        assert.ok(layout.image.y >= layout.body.y && layout.image.bottom <= layout.body.bottom, context);
        assert.equal(layout.fit, "scale-down", context);
        assert.equal(layout.overflow, false, context);
      }
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog").evaluate(dialog => dialog.open), false);
  } finally { await browser.close(); }
});
