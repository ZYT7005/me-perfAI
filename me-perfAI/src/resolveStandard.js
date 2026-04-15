import { fetchWithRetry } from "./fetchRetry.js";
import { getStandardUrlFetchTimeoutMs } from "./timeouts.js";

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * @param {{ file?: import("multer").File, standardUrl?: string, standardText?: string }}
 */
export async function resolveStandardSource({ file, standardUrl, standardText }) {
  if (file?.buffer?.length) {
    return { buffer: file.buffer, name: file.originalname || "upload" };
  }

  const url = (standardUrl || "").trim();
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error("标准文档链接不是合法 URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("标准文档链接仅支持 http / https");
    }
    const res = await fetchWithRetry(
      url,
      {
        redirect: "follow",
        headers: {
          "User-Agent": "me-perfAI/1.0",
          Accept: "text/html,text/plain,text/markdown,*/*;q=0.8"
        }
      },
      { label: "拉取标准文档", retries: 4, retryDelayMs: 800, timeoutMs: getStandardUrlFetchTimeoutMs() }
    );
    if (!res.ok) {
      throw new Error(`无法拉取标准文档（HTTP ${res.status}）`);
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) {
      throw new Error(`标准文档超过 ${MAX_BYTES / (1024 * 1024)}MB 上限`);
    }
    const pathPart = u.pathname.split("/").filter(Boolean).pop() || "";
    const name = pathPart.includes(".") ? pathPart : `${pathPart || "standard"}.md`;
    return { buffer: Buffer.from(ab), name };
  }

  const text = (standardText || "").trim();
  if (text) {
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      throw new Error(`粘贴内容超过 ${MAX_BYTES / (1024 * 1024)}MB 上限`);
    }
    return { buffer: Buffer.from(text, "utf8"), name: "paste.md" };
  }

  throw new Error("请提供标准文档：上传文件、粘贴内容或填写文档链接");
}
