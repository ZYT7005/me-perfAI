/**
 * Parse uploaded "standard" document: markdown checklists / thresholds or HTML reference.
 */

const METRIC_PATTERNS = [
  { key: "lcp", re: /LCP|largest\s*contentful\s*paint/i, valueRe: /(?:<|≤|under|以下)?\s*([\d.]+)\s*s/i },
  { key: "inp", re: /INP|interaction\s*to\s*next\s*paint/i, valueRe: /(?:<|≤|under|以下)?\s*([\d.]+)\s*ms/i },
  { key: "cls", re: /CLS|cumulative\s*layout\s*shift/i, valueRe: /(?:<|≤|under|以下)?\s*([\d.]+)/i },
  { key: "fcp", re: /FCP|first\s*contentful\s*paint/i, valueRe: /(?:<|≤|under|以下)?\s*([\d.]+)\s*s/i },
  { key: "tti", re: /TTI|time\s*to\s*interactive/i, valueRe: /(?:<|≤|under|以下)?\s*([\d.]+)\s*s/i }
];

function parseMarkdownStandard(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const thresholds = {};
  for (const line of lines) {
    for (const { key, re, valueRe } of METRIC_PATTERNS) {
      if (re.test(line)) {
        const m = line.match(valueRe);
        if (m) {
          const num = parseFloat(m[1]);
          if (!Number.isNaN(num)) thresholds[key] = num;
        }
      }
    }
  }
  return {
    kind: "markdown",
    lineCount: lines.length,
    thresholds,
    excerpt: text.slice(0, 4000)
  };
}

function parseHtmlStandard(html) {
  const scriptTags = (html.match(/<script\b/gi) || []).length;
  const imgTags = (html.match(/<img\b/gi) || []).length;
  const linkStyles = (html.match(/<link[^>]+rel\s*=\s*["']stylesheet["']/gi) || []).length;
  return {
    kind: "html",
    scriptTags,
    imgTags,
    stylesheetLinks: linkStyles,
    sizeBytes: Buffer.byteLength(html, "utf8"),
    excerpt: html.replace(/\s+/g, " ").slice(0, 2000)
  };
}

export function parseStandard(buffer, originalName = "") {
  const lower = originalName.toLowerCase();
  const text = buffer.toString("utf8");
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return parseMarkdownStandard(text);
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".liquid")) {
    return parseHtmlStandard(text);
  }
  if (/^\s*#|LCP|CLS|FCP|性能|优化/m.test(text)) {
    return parseMarkdownStandard(text);
  }
  return parseHtmlStandard(text);
}
