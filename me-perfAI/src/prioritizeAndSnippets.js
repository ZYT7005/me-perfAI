const SECTION_SOURCE_MAX = 400_000;

/** @param {{ metric: string }[]} gaps @param {{ id?: string, title?: string, description?: string, score?: number|null }[]} audits */
export function prioritizeSuggestions(gaps, audits) {
  const items = [];
  const gapRank = { LCP: 0, CLS: 1, FCP: 2 };
  (gaps || []).forEach((g, idx) => {
    const urgency = g.metric === "LCP" || g.metric === "CLS" ? "high" : "medium";
    items.push({
      kind: "threshold_gap",
      urgency,
      priorityScore: 1000 - (gapRank[g.metric] ?? 5) * 80 - idx * 2,
      title: `${g.metric} 未达标准阈值`,
      detail: g
    });
  });
  (audits || []).forEach((a, idx) => {
    const sc = a.score == null ? 0.5 : Number(a.score);
    const urgency = sc < 0.25 ? "high" : sc < 0.55 ? "medium" : "low";
    items.push({
      kind: "lighthouse_audit",
      urgency,
      priorityScore: 520 - sc * 380 - idx * 0.3,
      title: a.title || a.id || "Lighthouse 审计",
      detail: a
    });
  });
  items.sort((x, y) => y.priorityScore - x.priorityScore);
  items.forEach((it, i) => {
    it.rank = i + 1;
  });
  return items;
}

function collectTerms(item, focusKeywords) {
  const terms = new Set();
  (focusKeywords || []).slice(0, 120).forEach((k) => {
    const t = String(k).toLowerCase().trim();
    if (t.length >= 2) terms.add(t);
  });
  if (item.kind === "lighthouse_audit") {
    const a = item.detail;
    String(a.id || "")
      .split("-")
      .forEach((p) => {
        const x = p.toLowerCase();
        if (x.length > 2) terms.add(x);
      });
    String(a.title || "")
      .toLowerCase()
      .match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}/gi)
      ?.forEach((w) => terms.add(w.toLowerCase()));
    String(a.description || "")
      .slice(0, 240)
      .toLowerCase()
      .match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}/gi)
      ?.forEach((w) => terms.add(w.toLowerCase()));
  } else if (item.kind === "threshold_gap") {
    terms.add(String(item.detail.metric || "").toLowerCase());
    terms.add("lcp");
    terms.add("fcp");
    terms.add("cls");
  } else if (item.kind === "static_finding") {
    const d = item.detail || {};
    String(d.id || "")
      .split("-")
      .forEach((p) => {
        const x = p.toLowerCase();
        if (x.length > 1) terms.add(x);
      });
    String(d.category || "")
      .toLowerCase()
      .match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}/gi)
      ?.forEach((w) => terms.add(w.toLowerCase()));
    String(d.title || "")
      .toLowerCase()
      .match(/[\u4e00-\u9fff]{2,}|[a-z][a-z0-9_-]{2,}/gi)
      ?.forEach((w) => terms.add(w.toLowerCase()));
  }
  return [...terms].filter((t) => t.length >= 2);
}

/** @param {string} sectionText @param {object} item from prioritizeSuggestions @param {string[]} focusKeywords */
export function findSnippetForSuggestion(sectionText, item, focusKeywords) {
  const lines = sectionText.split(/\r?\n/);
  if (item.kind === "static_finding" && item.detail && Number.isFinite(item.detail.line)) {
    const lineNum = Math.max(1, Math.min(lines.length, Number(item.detail.line)));
    const bestIdx = lineNum - 1;
    const before = 4;
    const after = 14;
    const start = Math.max(0, bestIdx - before);
    const end = Math.min(lines.length, bestIdx + after + 1);
    return {
      rank: item.rank,
      startLine: start + 1,
      endLine: end,
      code: lines.slice(start, end).join("\n"),
      matchScore: 999
    };
  }
  const terms = collectTerms(item, focusKeywords);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (low.includes(t)) s += Math.min(t.length, 10);
    }
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestScore <= 0) {
    const nonEmpty = lines.findIndex((l) => l.trim().length > 0);
    bestIdx = nonEmpty >= 0 ? nonEmpty : 0;
    bestScore = 0;
  }
  const before = 4;
  const after = 14;
  const start = Math.max(0, bestIdx - before);
  const end = Math.min(lines.length, bestIdx + after + 1);
  return {
    rank: item.rank,
    startLine: start + 1,
    endLine: end,
    code: lines.slice(start, end).join("\n"),
    matchScore: bestScore
  };
}

export function truncateSectionSource(text) {
  if (Buffer.byteLength(text, "utf8") <= SECTION_SOURCE_MAX) {
    return { source: text, truncated: false, originalLength: text.length };
  }
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > SECTION_SOURCE_MAX && cut.length > 0) {
    cut = cut.slice(0, Math.floor(cut.length * 0.95));
  }
  return { source: cut, truncated: true, originalLength: text.length };
}

export { SECTION_SOURCE_MAX };

/** @param {string} original @param {string} fileName @param {object[]} prioritized @param {object[]} snippets */
export function buildOptimizedSectionExport(original, fileName, prioritized, snippets) {
  const lower = (fileName || "").toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop() || "txt" : "txt";
  const ts = new Date().toISOString();
  const byRank = new Map(snippets.map((s) => [s.rank, s]));

  const bodyLines = [];
  (prioritized || []).slice(0, 25).forEach((p) => {
    const sn = byRank.get(p.rank);
    bodyLines.push(`P${p.rank} [${String(p.urgency).toUpperCase()}] ${p.title}`);
    if (p.kind === "threshold_gap") {
      const g = p.detail;
      const a = g.metric === "CLS" ? `实测 ${g.actual} / 目标 ${g.target}` : `实测 ${g.actualSec}s / 目标 ${g.targetSec}s`;
      bodyLines.push(`  阈值：${a}`);
    } else if (p.kind === "static_finding") {
      const d = p.detail;
      bodyLines.push(`  模板扫描 [${d.category || ""}] 约第 ${d.line} 行：${d.message || d.title || ""}`);
    } else {
      const a = p.detail;
      bodyLines.push(`  审计：${a.id || ""} ${a.displayValue ? `(${a.displayValue})` : ""}`);
    }
    if (sn) bodyLines.push(`  定位文件参考行：${sn.startLine}-${sn.endLine}（匹配分 ${sn.matchScore}）`);
    bodyLines.push("");
  });
  const block = bodyLines.join("\n").trimEnd();

  if (ext === "liquid") {
    const safe = block.replace(/\{%/g, "{_%").replace(/%\}/g, "%_}").replace(/\{%\s*endcomment/gi, "{_% endcomment");
    return `${original.replace(/\s+$/, "")}\n\n{% comment %} me-perfAI appendix ${ts}\n${safe}\n{% endcomment %}\n`;
  }
  if (ext === "html" || ext === "htm") {
    const esc = block.replace(/--/g, "—");
    return `${original.replace(/\s+$/, "")}\n\n<!-- me-perfAI appendix ${ts} -->\n<!--\n${esc}\n-->\n`;
  }
  return `${original.replace(/\s+$/, "")}\n\n---\n## me-perfAI 优化附录 (${ts})\n\n\`\`\`text\n${block}\n\`\`\`\n`;
}
