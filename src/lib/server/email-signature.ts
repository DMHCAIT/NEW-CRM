import sanitizeHtml from "sanitize-html";

export { MAX_SIGNATURE_LENGTH } from "@/lib/email-signature-policy";

const dimension = /^(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|pt|%)|auto)$/;
const spacing = /^(?:(?:0|\d{1,4}(?:\.\d{1,2})?(?:px|pt|%)|auto)\s*){1,4}$/;
const border = /^(?:0|(?:\d{1,2}px)\s+(?:solid|dashed|dotted)\s+(?:#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?\s*\)))$/i;

export function sanitizeSignature(value: string) {
  return sanitizeHtml(value, {
    allowedTags: ["p", "br", "div", "span", "strong", "b", "em", "i", "u", "a", "img", "table", "tbody", "thead", "tr", "td", "th", "ul", "ol", "li", "hr"],
    allowedAttributes: {
      "*": ["style", "width", "height", "align", "valign"],
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      table: ["style", "width", "height", "align", "valign", "cellpadding", "cellspacing", "border", "bgcolor"],
    },
    allowedSchemes: ["https", "http", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}\s*\)$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i],
        "font-size": [/^(?:0|\d{1,2}(?:px|pt))$/],
        "font-family": [/^[a-zA-Z ,'-]+$/],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "font-style": [/^(?:normal|italic)$/],
        "text-align": [/^(?:left|right|center)$/],
        "text-decoration": [/^(?:none|underline)$/],
        "line-height": [/^(?:\d{1,3}(?:\.\d{1,2})?(?:px|pt|%)?|normal)$/],
        width: [dimension], height: [dimension],
        "min-width": [dimension], "max-width": [dimension],
        "min-height": [dimension], "max-height": [dimension],
        padding: [spacing], margin: [spacing],
        "padding-left": [dimension], "padding-right": [dimension],
        "padding-top": [dimension], "padding-bottom": [dimension],
        "margin-left": [dimension], "margin-right": [dimension],
        "margin-top": [dimension], "margin-bottom": [dimension],
        border: [border], "border-left": [border], "border-right": [border],
        "border-top": [border], "border-bottom": [border],
        "border-radius": [/^\d{1,3}(?:px|%)$/],
        "letter-spacing": [/^-?\d(?:\.\d{1,2})?px$/],
        display: [/^(?:block|inline|inline-block|table|table-row|table-cell)$/],
        "object-fit": [/^(?:cover|contain|fill|none|scale-down)$/],
        "white-space": [/^(?:normal|nowrap|pre-wrap)$/],
        "table-layout": [/^(?:fixed|auto)$/],
        "border-collapse": [/^(?:collapse|separate)$/],
        "vertical-align": [/^(?:top|middle|bottom)$/],
      },
    },
  }).trim();
}

export function signatureText(html: string) {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|tr|li)>/gi, "\n");
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}
