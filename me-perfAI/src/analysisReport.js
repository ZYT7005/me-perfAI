/**
 * Structured analysis report for API + UI (PSI mode or static template mode).
 */

const CAT_LABEL = {
  threshold_gap: "与性能标准阈值",
  lighthouse_audit: "Lighthouse 实测",
  static_finding: "模板静态扫描"
};

/**
 * @param {'psi'|'static'} mode
 * @param {object[]} prioritized from one result row
 * @param {{ metric: string }[]} gaps
 * @param {object[]} scopedAudits
 */
export function buildAnalysisReport(mode, prioritized, gaps, scopedAudits) {
  const list = prioritized || [];
  const byKind = { threshold_gap: [], lighthouse_audit: [], static_finding: [] };
  const byUrgency = { high: 0, medium: 0, low: 0 };

  for (const item of list) {
    const k = item.kind;
    if (byKind[k]) byKind[k].push(item);
    const u = item.urgency;
    if (u === "high" || u === "medium" || u === "low") byUrgency[u] += 1;
  }

  const bullets = [];
  for (const item of list.slice(0, 12)) {
    if (item.kind === "threshold_gap" && item.detail) {
      const g = item.detail;
      const v =
        g.metric === "CLS"
          ? `CLS 实测 ${g.actual}，目标 ${g.target}`
          : `${g.metric} 实测 ${g.actualSec}s，目标 ${g.targetSec}s`;
      bullets.push({ text: `${g.metric}：${v}`, urgency: item.urgency, category: CAT_LABEL.threshold_gap });
    } else if (item.kind === "lighthouse_audit" && item.detail) {
      const a = item.detail;
      bullets.push({
        text: `${a.title || a.id || "审计"}${a.displayValue ? `（${a.displayValue}）` : ""}`,
        urgency: item.urgency,
        category: CAT_LABEL.lighthouse_audit
      });
    } else if (item.kind === "static_finding" && item.detail) {
      const d = item.detail;
      bullets.push({
        text: `第 ${d.line} 行 · ${d.title}`,
        urgency: item.urgency,
        category: d.category || CAT_LABEL.static_finding
      });
    }
  }

  let summary =
    mode === "static"
      ? `基于模板内容的静态规则扫描，共标记 ${list.length} 处可优化点（紧急 ${byUrgency.high}、中等 ${byUrgency.medium}、一般 ${byUrgency.low}）。未调用线上 PageSpeed，结果仅供参考。`
      : `结合 PageSpeed Insights 与您的标准文档，共整理 ${list.length} 条优先建议（紧急 ${byUrgency.high}、中等 ${byUrgency.medium}、一般 ${byUrgency.low}）。`;

  if (gaps?.length && mode === "psi") {
    summary += ` 其中 ${gaps.length} 项与文档中声明的 LCP/FCP/CLS 阈值存在差距。`;
  }
  if (scopedAudits?.length && mode === "psi") {
    summary += ` 与定位文档关键词相关的失败审计约 ${scopedAudits.length} 条。`;
  }

  const categoryGroups = {};
  for (const b of bullets) {
    if (!categoryGroups[b.category]) categoryGroups[b.category] = [];
    categoryGroups[b.category].push(b);
  }

  return {
    mode,
    summary,
    counts: {
      total: list.length,
      high: byUrgency.high,
      medium: byUrgency.medium,
      low: byUrgency.low,
      thresholdGaps: gaps?.length ?? 0,
      scopedAudits: scopedAudits?.length ?? 0
    },
    bullets,
    categoryGroups,
    byKindCounts: {
      threshold: byKind.threshold_gap.length,
      lighthouse: byKind.lighthouse_audit.length,
      static: byKind.static_finding.length
    }
  };
}
