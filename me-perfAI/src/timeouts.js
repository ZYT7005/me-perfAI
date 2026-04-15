/** PageSpeed 单次请求允许的等待时间：2～5 分钟区间（可环境变量覆盖） */
const PSI_MIN_MS = 120_000;
const PSI_MAX_MS = 300_000;

/** 拉取标准文档 URL：同属 2～5 分钟区间，默认取区间下限以更快失败 */
const STANDARD_MIN_MS = 120_000;
const STANDARD_MAX_MS = 300_000;

function clampMs(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** @returns {number} 单次 PageSpeed API fetch 超时（毫秒） */
export function getPsiFetchTimeoutMs() {
  return clampMs(process.env.PSI_FETCH_TIMEOUT_MS, PSI_MAX_MS, PSI_MIN_MS, PSI_MAX_MS);
}

/** @returns {number} 拉取标准文档 URL 超时（毫秒） */
export function getStandardUrlFetchTimeoutMs() {
  return clampMs(process.env.STANDARD_FETCH_TIMEOUT_MS, STANDARD_MIN_MS, STANDARD_MIN_MS, STANDARD_MAX_MS);
}
