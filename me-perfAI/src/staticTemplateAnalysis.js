/**
 * Heuristic static scan for Liquid / HTML templates when no URL is available for PSI.
 */

/** @typedef {{ id: string, category: string, severity: 'high'|'medium'|'low', title: string, message: string, line: number }} StaticFinding */

/**
 * @param {string} text
 * @param {string} fileName
 * @returns {StaticFinding[]}
 */
export function analyzeStaticTemplate(text, fileName = "") {
  const lines = text.split(/\r?\n/);
  /** @type {StaticFinding[]} */
  const out = [];
  const seen = new Set();
  const key = (id, line) => `${id}:${line}`;

  const push = (finding) => {
    const k = key(finding.id, finding.line);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(finding);
  };

  let stylesheetCount = 0;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const l = raw.toLowerCase();
    const trim = raw.trim();

    if (trim.startsWith("{%-") || trim.startsWith("{%")) {
      if (/\bjavascript\b/.test(l) && /\%\}/.test(trim)) {
        push({
          id: "liquid-javascript",
          category: "Liquid",
          severity: "low",
          title: "Liquid javascript 片段",
          message: "Shopify 等平台的 {% javascript %} 会打包为独立资源，注意体积与首屏依赖。",
          line
        });
      }
      if (/\bstylesheet\b/.test(l) && /\%\}/.test(trim)) {
        push({
          id: "liquid-stylesheet",
          category: "Liquid",
          severity: "low",
          title: "Liquid stylesheet 片段",
          message: "{% stylesheet %} 会增加 CSS 体积，确认是否仅在必要时使用。",
          line
        });
      }
    }

    if (l.includes("<img")) {
      if (!l.includes("loading=")) {
        push({
          id: "img-lazy",
          category: "图片",
          severity: "medium",
          title: "图片未设置 loading 属性",
          message: "非首屏大图建议 loading=\"lazy\"，减少首屏带宽与 LCP 竞争。",
          line
        });
      }
      const hasW = /\bwidth\s*=/.test(l) || /\bwidth:\s*\d/.test(l);
      const hasH = /\bheight\s*=/.test(l) || /\bheight:\s*\d/.test(l);
      const hasAspect = /aspect-ratio|aspect_ratio|ar-[\w-]+/i.test(raw);
      if (!hasW && !hasH && !hasAspect) {
        push({
          id: "img-dimensions",
          category: "布局 CLS",
          severity: "medium",
          title: "图片未声明宽高或比例",
          message: "缺少 width/height 或 aspect-ratio 易导致布局偏移（CLS）。",
          line
        });
      }
    }

    if (l.includes("<script")) {
      const hasSrc = /\bsrc\s*=/.test(l);
      const isModule = /\btype\s*=\s*["']module["']/.test(l);
      const hasDefer = /\bdefer\b/.test(l);
      const hasAsync = /\basync\b/.test(l);
      if (hasSrc && !hasDefer && !hasAsync && !isModule) {
        push({
          id: "script-blocking",
          category: "脚本",
          severity: "high",
          title: "外部脚本可能阻塞解析",
          message: "带 src 的 script 未使用 defer/async 或 type=module，易阻塞首屏渲染。",
          line
        });
      }
      if (!hasSrc && raw.length > 400 && !l.includes("application/ld+json") && !l.includes("type=\"application/json\"")) {
        push({
          id: "inline-script-large",
          category: "脚本",
          severity: "medium",
          title: "较大内联脚本",
          message: "长内联脚本增加 HTML 体积并阻塞解析，可拆到外部文件并 defer。",
          line
        });
      }
    }

    if (l.includes("<link") && /rel\s*=\s*["']stylesheet["']/.test(l)) {
      stylesheetCount += 1;
      if (stylesheetCount <= 8) {
        push({
          id: "stylesheet-link",
          category: "样式",
          severity: "medium",
          title: "外链样式表（渲染依赖）",
          message: `第 ${stylesheetCount} 处 stylesheet link；过多外链 CSS 易形成渲染阻塞，考虑关键 CSS 内联或合并。`,
          line
        });
      }
    }

    if (l.includes("@font-face") && !l.includes("font-display")) {
      push({
        id: "font-display",
        category: "字体",
        severity: "medium",
        title: "@font-face 未设置 font-display",
        message: "建议 font-display: swap 或 optional，减少 FOIT、改善 FCP。",
        line
      });
    }

    if (l.includes("iframe") && !l.includes("loading=")) {
      push({
        id: "iframe-lazy",
        category: "嵌入",
        severity: "low",
        title: "iframe 可考虑懒加载",
        message: "第三方 iframe 可使用 loading=\"lazy\" 或延后注入。",
        line
      });
    }
  });

  return out;
}

/**
 * @param {StaticFinding[]} findings
 */
export function prioritizedFromStaticFindings(findings) {
  const weight = { high: 100, medium: 60, low: 30 };
  const sorted = [...findings].sort((a, b) => {
    const dw = weight[b.severity] - weight[a.severity];
    if (dw !== 0) return dw;
    return a.line - b.line;
  });
  return sorted.map((f, idx) => ({
    kind: "static_finding",
    urgency: f.severity,
    priorityScore: 900 - idx * 3 - (f.severity === "high" ? 40 : f.severity === "low" ? 0 : 15),
    title: f.title,
    detail: f
  })).map((it, i) => {
    it.rank = i + 1;
    return it;
  });
}
