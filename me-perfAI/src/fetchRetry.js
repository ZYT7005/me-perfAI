import { ProxyAgent, fetch as undiciFetch } from "undici";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {unknown} err */
function isRetryableNetworkError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ code?: string; message?: string; cause?: unknown }} */ (err);
  const cause = e.cause && typeof e.cause === "object" ? /** @type {{ code?: string }} */ (e.cause) : null;
  const code = cause?.code || e.code;
  const msg = (e.message || "").toLowerCase();
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE" || code === "ECONNREFUSED") return true;
  if (msg.includes("terminated") || msg.includes("econnreset")) return true;
  return false;
}

/** @param {string} label @param {unknown} err */
export function formatFetchError(label, err) {
  const e = err && typeof err === "object" ? /** @type {{ message?: string; cause?: unknown }} */ (err) : null;
  const cause = e?.cause && typeof e.cause === "object" ? /** @type {{ code?: string; message?: string }} */ (e.cause) : null;
  const code = cause?.code || (err && typeof err === "object" && "code" in err ? String(/** @type {{ code?: string }} */ (err).code) : "");

  if (code === "ECONNRESET" || (e?.message || "").toLowerCase().includes("terminated")) {
    const psi =
      label.includes("PageSpeed") ?
        " 另：PageSpeed 走 Google 接口，若在本机无法直连谷歌，需在系统/终端配置可访问外网的代理后再试。" :
      "";
    return `${label}失败：连接被中断（ECONNRESET）。常见于网络不稳定、公司代理/VPN 或目标站限制；可换网络、配置代理后重试；标准文档也可改用「粘贴」避免拉取外链。${psi}`;
  }
  if (code === "ETIMEDOUT") {
    return `${label}失败：连接超时。请检查网络或稍后重试。`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${label}失败：域名无法解析（${code}）。请检查 URL 是否正确。`;
  }
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED") {
    return `${label}失败：TLS 证书问题（${code}）。`;
  }

  const tail = e?.message || cause?.message || (err instanceof Error ? err.message : String(err));
  return `${label}失败：${tail || "未知错误"}`;
}

/**
 * 读取代理地址：优先 HTTPS_PROXY，其次 HTTP_PROXY，均无则返回 null
 * @returns {ProxyAgent | undefined}
 */
function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY  || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  try {
    return new ProxyAgent(proxyUrl);
  } catch (e) {
    console.warn("[fetchRetry] 无法创建代理 Agent（%s）：%s", proxyUrl, e.message);
    return undefined;
  }
}

/**
 * @param {string | URL | Request} url
 * @param {RequestInit} [init]
 * @param {{ retries?: number, retryDelayMs?: number, timeoutMs?: number, label?: string }} [opts]
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { retries = 4, retryDelayMs = 700, timeoutMs = 120_000, label = "网络请求" } = opts;
  let lastErr;

  const dispatcher = getProxyAgent();

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
      // 若配置了代理则走 undici fetch（支持 dispatcher），否则走全局 fetch
      const fetchFn = dispatcher ? undiciFetch : fetch;
      const fetchInit = dispatcher
        ? { ...init, signal, dispatcher }
        : { ...init, signal };
      const res = await fetchFn(url, fetchInit);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1 && isRetryableNetworkError(err)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      break;
    }
  }

  throw new Error(formatFetchError(label, lastErr));
}
