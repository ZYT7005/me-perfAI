/**
 * Section doc: extract target URLs and scope keywords (headings, bullets) for filtering audits.
 */

const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/gi;

function tokenize(line) {
  return line
    .replace(/^[#>*\-\d.\s]+/g, "")
    .split(/[\s，、,；;。./\\|]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

export function parseSection(buffer, originalName = "") {
  const text = buffer.toString("utf8");
  const urls = [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?)]+$/, "")))];
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  const focusChunks = [];
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const content = line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
      if (content.length > 1) focusChunks.push(content);
    }
  }

  const focusKeywords = new Set();
  for (const chunk of focusChunks) {
    for (const t of tokenize(chunk)) {
      if (t.length >= 2 && !/^https?:/i.test(t)) focusKeywords.add(t.toLowerCase());
    }
  }
  for (const t of tokenize(text)) {
    if (t.length >= 2 && !/^https?:/i.test(t)) focusKeywords.add(t.toLowerCase());
  }

  const lowerName = originalName.toLowerCase();
  const kind = lowerName.endsWith(".md") || lowerName.endsWith(".markdown") ? "markdown" : lowerName.endsWith(".liquid") ? "liquid" : "text";
  return {
    kind,
    urls,
    focusHeadingsAndBullets: focusChunks.slice(0, 80),
    focusKeywords: [...focusKeywords].slice(0, 200),
    excerpt: text.slice(0, 4000)
  };
}

export function scoreAuditRelevance(auditTitle, auditDescription, keywords) {
  if (!keywords.length) return 0;
  const blob = `${auditTitle || ""} ${auditDescription || ""}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (kw.length < 2) continue;
    if (blob.includes(kw)) score += 2;
  }
  return score;
}
