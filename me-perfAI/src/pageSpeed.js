import { fetchWithRetry } from "./fetchRetry.js";
import { getPsiFetchTimeoutMs } from "./timeouts.js";

const BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export async function runPageSpeed(url, apiKey, options = {}) {
  // 默认仅查 performance，大幅加快请求速度
  const { strategy = "mobile", locale = "zh_CN", categories = ["performance"] } = options;
  if (!apiKey) {
    throw new Error("缺少 PAGE_SPEED_API_KEY，请在 .env 中配置");
  }
  const params = new URLSearchParams({ url, key: apiKey, strategy });
  if (locale) params.set("locale", locale);
  for (const c of categories) params.append("category", c);
  
  const apiUrl = `${BASE}?${params.toString()}`;
  const psiTimeoutMs = options.timeoutMs ?? getPsiFetchTimeoutMs();
  
  // 打印构建出来的真实 URL 到服务端日志，方便验证 “且请求时需要带参” 的格式
  console.log(`[PageSpeed] Requesting: ${BASE}?url=${url}&strategy=${strategy}&category=${categories.join(",")}`);

  const res = await fetchWithRetry(apiUrl, { method: "GET" }, { label: "PageSpeed API", retries: 4, retryDelayMs: 1000, timeoutMs: psiTimeoutMs });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PageSpeed API ${res.status}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

export function summarizePsi(json) {
  const lh = json?.lighthouseResult;
  if (!lh) return { error: "响应中无 lighthouseResult" };

  const categories = {};
  for (const [id, cat] of Object.entries(lh.categories || {})) {
    categories[id] = cat?.score != null ? Math.round(cat.score * 100) : null;
  }

  const audits = lh.audits || {};
  const metrics = {};
  for (const key of ["largest-contentful-paint", "first-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "speed-index", "interactive"]) {
    const a = audits[key];
    if (a?.numericValue != null) {
      metrics[key] = {
        displayValue: a.displayValue,
        numericValue: a.numericValue,
        score: a.score
      };
    }
  }

  const failed = [];
  for (const [id, a] of Object.entries(audits)) {
    if (a?.score === null && a?.scoreDisplayMode === "error") continue;
    if (a?.score !== null && a?.score !== undefined && a.score < 1 && a.scoreDisplayMode !== "informative") {
      failed.push({
        id,
        title: a.title,
        description: (a.description || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 400),
        score: a.score,
        displayValue: a.displayValue
      });
    }
  }
  failed.sort((x, y) => (x.score ?? 0) - (y.score ?? 0));
  const failedCapped = failed.slice(0, 80);

  return {
    finalUrl: lh.finalUrl,
    fetchTime: lh.fetchTime,
    categories,
    metrics,
    failedAudits: failedCapped
  };
}
