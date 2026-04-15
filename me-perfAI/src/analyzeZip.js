import AdmZip from "adm-zip";
import path from "path";
import { analyzeStaticTemplate, prioritizedFromStaticFindings } from "./staticTemplateAnalysis.js";
import { findSnippetForSuggestion } from "./prioritizeAndSnippets.js";

/** 扫描这些扩展名的文件做静态性能分析 */
const SCAN_EXTS = new Set([".liquid", ".html", ".htm"]);
/** 允许列出（但不深度扫描）的扩展名 */
const ALLOW_EXTS = new Set([".liquid", ".html", ".htm", ".js", ".css", ".json", ".md", ".txt"]);
const MAX_FILES = 300;
const MAX_SCAN_SIZE = 600 * 1024; // 单文件最大扫描体积 600KB

/**
 * 解析 ZIP buffer，对其中的模板文件做静态性能扫描
 * @param {Buffer} buffer
 * @param {string} zipName
 * @returns {{ file: string, ext: string, lineCount: number, skipped?: boolean, reason?: string, findings: object[], prioritized: object[], snippets: object[] }[]}
 */
export function analyzeZipBuffer(buffer, zipName = "archive.zip") {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error("无法解析压缩包，请确认是有效的 .zip 文件");
  }

  const entries = zip.getEntries();
  const results = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryName = entry.entryName.replace(/\\/g, "/");

    // 跳过 macOS 元数据、隐藏文件、node_modules
    if (
      entryName.startsWith("__MACOSX/") ||
      entryName.includes("/node_modules/") ||
      entryName.includes("/.") ||
      path.basename(entryName).startsWith(".")
    ) continue;

    const ext = path.extname(entryName).toLowerCase();
    if (!ALLOW_EXTS.has(ext)) continue;
    if (fileCount >= MAX_FILES) break;
    fileCount++;

    const compressedSize = entry.header.compressedSize || 0;
    const uncompressedSize = entry.header.size || 0;

    if (uncompressedSize > MAX_SCAN_SIZE) {
      results.push({
        file: entryName, ext,
        lineCount: 0,
        skipped: true,
        reason: `文件过大（${Math.round(uncompressedSize / 1024)}KB），跳过扫描`,
        findings: [], prioritized: [], snippets: []
      });
      continue;
    }

    let text;
    try {
      text = entry.getData().toString("utf8");
    } catch {
      results.push({
        file: entryName, ext,
        lineCount: 0,
        skipped: true,
        reason: "文件读取失败（可能为二进制或编码问题）",
        findings: [], prioritized: [], snippets: []
      });
      continue;
    }

    const lineCount = text.split("\n").length;

    if (SCAN_EXTS.has(ext)) {
      const findings = analyzeStaticTemplate(text, entryName);
      const prioritized = prioritizedFromStaticFindings(findings);
      const snippets = prioritized.map(item =>
        findSnippetForSuggestion(text, item, [])
      );
      results.push({ file: entryName, ext, lineCount, findings, prioritized, snippets });
    } else {
      // JS/CSS/JSON/MD 等：仅记录文件，不做静态扫描
      results.push({ file: entryName, ext, lineCount, findings: [], prioritized: [], snippets: [] });
    }
  }

  // 按问题数量降序排列，问题多的文件排在前面
  results.sort((a, b) => b.findings.length - a.findings.length);
  return results;
}

/** 汇总统计 */
export function summarizeZipResults(fileResults) {
  let totalFindings = 0, high = 0, medium = 0, low = 0, scannedFiles = 0;
  for (const r of fileResults) {
    if (r.skipped) continue;
    if (SCAN_EXTS.has(r.ext)) scannedFiles++;
    totalFindings += r.findings.length;
    for (const p of r.prioritized) {
      if (p.urgency === "high") high++;
      else if (p.urgency === "medium") medium++;
      else low++;
    }
  }
  return { totalFiles: fileResults.length, scannedFiles, totalFindings, high, medium, low };
}
