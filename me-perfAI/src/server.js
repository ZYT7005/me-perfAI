import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { parseStandard } from "./parseStandard.js";
import { parseSection, scoreAuditRelevance } from "./parseSection.js";
import { runPageSpeed, summarizePsi } from "./pageSpeed.js";
import { resolveStandardSource } from "./resolveStandard.js";
import { getPsiFetchTimeoutMs } from "./timeouts.js";
import {
  prioritizeSuggestions,
  findSnippetForSuggestion,
  truncateSectionSource,
  buildOptimizedSectionExport,
  SECTION_SOURCE_MAX
} from "./prioritizeAndSnippets.js";
import { analyzeStaticTemplate, prioritizedFromStaticFindings } from "./staticTemplateAnalysis.js";
import { buildAnalysisReport } from "./analysisReport.js";
import { callOpenrouterFix } from "./openrouter.js";
import { analyzeZipBuffer, summarizeZipResults } from "./analyzeZip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 2 }
});
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }
});

const app = express();
app.use(express.json({ limit: "2mb" }));

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

function compareWithStandard(standard, summary) {
  const gaps = [];
  const thr = standard.thresholds || {};
  const m = summary.metrics || {};

  const lcp = m["largest-contentful-paint"]?.numericValue;
  if (thr.lcp != null && lcp != null) {
    const sec = lcp / 1000;
    if (sec > thr.lcp) gaps.push({ metric: "LCP", actualSec: round2(sec), targetSec: thr.lcp });
  }
  const fcp = m["first-contentful-paint"]?.numericValue;
  if (thr.fcp != null && fcp != null) {
    const sec = fcp / 1000;
    if (sec > thr.fcp) gaps.push({ metric: "FCP", actualSec: round2(sec), targetSec: thr.fcp });
  }
  const cls = m["cumulative-layout-shift"]?.numericValue;
  if (thr.cls != null && cls != null && cls > thr.cls) {
    gaps.push({ metric: "CLS", actual: round4(cls), target: thr.cls });
  }

  return gaps;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

app.post(
  "/api/analyze",
  upload.fields([
    { name: "standard", maxCount: 1 },
    { name: "section", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      /** @type {Record<string, import("multer").File[]> | undefined} */
      const mfiles = req.files;
      const standardFile = mfiles?.standard?.[0];
      const sectionFile = mfiles?.section?.[0];
      if (!sectionFile?.buffer?.length) {
        return res.status(400).json({ error: "请上传定位 / 模板文件（.liquid、.html、.md 等）。无 URL 时将仅做模板静态扫描。" });
      }

      const strategy = req.query?.strategy === "desktop" || req.body?.strategy === "desktop" ? "desktop" : "mobile";
      const urlParam = typeof req.query?.url === "string" ? req.query.url : typeof req.body?.url === "string" ? req.body.url : "";
      const overrideUrl = urlParam.trim();

      const hasStandardInput =
        Boolean(standardFile?.buffer?.length) ||
        (typeof req.body?.standardUrl === "string" && req.body.standardUrl.trim()) ||
        (typeof req.body?.standardText === "string" && req.body.standardText.trim());

      let standardBuf;
      let standardName;
      if (!hasStandardInput) {
        standardBuf = Buffer.from(
          "# 未提供性能标准\n\n未配置 LCP / FCP / CLS 阈值。上传仅模板扫描时可留空此项。\n",
          "utf8"
        );
        standardName = "default.md";
      } else {
        try {
          const resolved = await resolveStandardSource({
            file: standardFile,
            standardUrl: typeof req.body?.standardUrl === "string" ? req.body.standardUrl : "",
            standardText: typeof req.body?.standardText === "string" ? req.body.standardText : ""
          });
          standardBuf = resolved.buffer;
          standardName = resolved.name;
        } catch (e) {
          return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
      }

      const standard = parseStandard(standardBuf, standardName || "");
      const section = parseSection(sectionFile.buffer, sectionFile.originalname || "");
      const sectionFullText = sectionFile.buffer.toString("utf8");
      const { source: sectionSource, truncated: sectionSourceTruncated, originalLength: sectionSourceOriginalLength } =
        truncateSectionSource(sectionFullText);

      let targetUrls = [...section.urls];
      if (overrideUrl) targetUrls = [overrideUrl];
      targetUrls = [...new Set(targetUrls)];

      const sectionPayload = {
        fileName: sectionFile.originalname || "",
        urls: section.urls,
        focusHeadingsAndBullets: section.focusHeadingsAndBullets,
        focusKeywordCount: section.focusKeywords.length,
        focusKeywords: section.focusKeywords.slice(0, 80),
        source: sectionSource,
        sourceTruncated: sectionSourceTruncated,
        sourceOriginalLength: sectionSourceOriginalLength,
        sourceMaxBytes: SECTION_SOURCE_MAX
      };

      if (!targetUrls.length) {
        const rawFindings = analyzeStaticTemplate(sectionFullText, sectionFile.originalname || "");
        let prioritizedSuggestions = prioritizedFromStaticFindings(rawFindings);
        if (!prioritizedSuggestions.length) {
          prioritizedSuggestions = [
            {
              kind: "static_finding",
              urgency: "low",
              priorityScore: 1,
              rank: 1,
              title: "未发现典型静态告警",
              detail: {
                id: "no-pattern",
                category: "概览",
                severity: "low",
                title: "未发现典型静态告警",
                message:
                  "未匹配到常见性能反模式（如阻塞脚本、未 lazy 的图片等）。需要线上指标时，请在文档或「目标 URL」中提供可访问的 https 链接以运行 PageSpeed。",
                line: 1
              }
            }
          ];
        }
        const sectionSnippets = prioritizedSuggestions.map((item) =>
          findSnippetForSuggestion(sectionSource, item, section.focusKeywords)
        );
        const optimizedSectionPreview = buildOptimizedSectionExport(
          sectionFullText,
          sectionFile.originalname || "section.txt",
          prioritizedSuggestions,
          sectionSnippets
        );
        const analysisReport = buildAnalysisReport("static", prioritizedSuggestions, [], []);
        return res.json({
          mode: "static",
          analysisReport,
          standard,
          section: sectionPayload,
          strategy,
          results: [
            {
              url: null,
              strategy,
              staticOnly: true,
              summary: { metrics: {}, categories: {}, failedAudits: [] },
              scopedAudits: [],
              thresholdGaps: [],
              prioritizedSuggestions,
              sectionSnippets,
              optimizedSectionPreview,
              fixedCode: "静态扫描模式尚未集成自动修复。"
            }
          ]
        });
      }

      const psiTimeoutMs = getPsiFetchTimeoutMs();
      const analyzeSocketMs = psiTimeoutMs * targetUrls.length + 120_000;
      req.setTimeout(analyzeSocketMs);

      const apiKey = process.env.PAGE_SPEED_API_KEY;
      const locale = process.env.PSI_LOCALE || "zh_CN";

      const results = [];
      for (const url of targetUrls) {
        const raw = await runPageSpeed(url, apiKey, { strategy, locale, timeoutMs: psiTimeoutMs });
        const summary = summarizePsi(raw);
        const scoped = filterScopedAudits(summary, section);
        const gaps = compareWithStandard(standard, summary);
        const prioritizedSuggestions = prioritizeSuggestions(gaps, scoped);
        const sectionSnippets = prioritizedSuggestions.map((item) =>
          findSnippetForSuggestion(sectionSource, item, section.focusKeywords)
        );
        const optimizedSectionPreview = buildOptimizedSectionExport(
          sectionFullText,
          sectionFile.originalname || "section.txt",
          prioritizedSuggestions,
          sectionSnippets
        );
        const issueTextList = prioritizedSuggestions.slice(0, 5).map(item => item.title);
        const issueText = issueTextList.length ? issueTextList.join(", ") : "综合性能优化";
        console.log("Calling OpenRouter with issues:", issueText);
        const autoFixResult = await callOpenrouterFix(sectionFullText, issueText);

        results.push({
          url,
          strategy,
          summary,
          scopedAudits: scoped,
          thresholdGaps: gaps,
          prioritizedSuggestions,
          sectionSnippets,
          optimizedSectionPreview,
          fixedCode: autoFixResult.fixedCode,
          fixedError: autoFixResult.error
        });
      }

      const analysisReport = buildAnalysisReport(
        "psi",
        results[0]?.prioritizedSuggestions || [],
        results[0]?.thresholdGaps || [],
        results[0]?.scopedAudits || []
      );

      res.json({
        mode: "psi",
        analysisReport,
        standard,
        section: sectionPayload,
        strategy,
        results
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
);

function filterScopedAudits(summary, section) {
  const failed = summary.failedAudits || [];
  const kws = section.focusKeywords || [];
  if (!kws.length) return failed.slice(0, 25);

  const scored = failed.map((a) => ({
    ...a,
    _rel: scoreAuditRelevance(a.title, a.description, kws),
    _base: a.score != null ? a.score : 0
  }));
  scored.sort((a, b) => {
    if (b._rel !== a._rel) return b._rel - a._rel;
    return (a._base ?? 0) - (b._base ?? 0);
  });

  const topScoped = scored.filter((a) => a._rel > 0).slice(0, 18);
  const merged = topScoped.length >= 8 ? topScoped : [...topScoped, ...scored.filter((a) => a._rel === 0).slice(0, 20 - topScoped.length)];
  return merged.map(({ _rel, _base, ...rest }) => rest);
}

/** 快速分析：仅传 URL/域名，自动使用 standard.md，无需上传文件 */
app.post("/api/quick", async (req, res) => {
  try {
    let urlParam = (
      typeof req.body?.url === "string" ? req.body.url :
        typeof req.query?.url === "string" ? req.query.url : ""
    ).trim();

    if (!urlParam) {
      return res.status(400).json({ error: "请提供目标 URL 或域名" });
    }
    // 自动补全协议
    if (!/^https?:\/\//i.test(urlParam)) {
      urlParam = "https://" + urlParam;
    }
    let parsedUrl;
    try { parsedUrl = new URL(urlParam); } catch {
      return res.status(400).json({ error: "无法解析 URL，请检查格式（如 example.com 或 https://example.com）" });
    }
    const targetUrl = parsedUrl.href;
    const strategy = req.body?.strategy === "desktop" || req.query?.strategy === "desktop" ? "desktop" : "mobile";

    // 自动读取 standard.md，否则使用内置默认阈值
    const standardPath = path.join(root, "standard.md");
    let standardBuf;
    if (fs.existsSync(standardPath)) {
      standardBuf = fs.readFileSync(standardPath);
    } else {
      standardBuf = Buffer.from("# 性能标准\nLCP < 2.5s\nFCP < 1.8s\nCLS < 0.1\n", "utf8");
    }
    const standard = parseStandard(standardBuf, "standard.md");

    const psiTimeoutMs = getPsiFetchTimeoutMs();
    req.setTimeout(psiTimeoutMs + 60_000);

    const apiKey = process.env.PAGE_SPEED_API_KEY;
    const locale = process.env.PSI_LOCALE || "zh_CN";

    const raw = await runPageSpeed(targetUrl, apiKey, { strategy, locale, timeoutMs: psiTimeoutMs });
    const summary = summarizePsi(raw);
    const gaps = compareWithStandard(standard, summary);
    const scoped = (summary.failedAudits || []).slice(0, 20);
    const prioritizedSuggestions = prioritizeSuggestions(gaps, scoped);
    const analysisReport = buildAnalysisReport("psi", prioritizedSuggestions, gaps, scoped);

    // 返回与 /api/analyze 相同的数据结构，方便前端复用渲染逻辑
    res.json({
      mode: "psi",
      analysisReport,
      standard,
      section: {
        fileName: "",
        urls: [targetUrl],
        focusHeadingsAndBullets: [],
        focusKeywordCount: 0,
        focusKeywords: [],
        source: "",
        sourceTruncated: false,
        sourceOriginalLength: 0,
        sourceMaxBytes: 0
      },
      strategy,
      results: [{
        url: targetUrl,
        strategy,
        summary,
        scopedAudits: scoped,
        thresholdGaps: gaps,
        prioritizedSuggestions,
        sectionSnippets: [],
        optimizedSectionPreview: ""
      }]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 压缩包分析：上传 .zip → 解压 → 多文件静态性能扫描 */
app.post("/api/analyze-zip", uploadZip.single("archive"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: "请上传 .zip 格式的压缩包" });
    }
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".zip") {
      return res.status(400).json({ error: "仅支持 .zip 格式，请重新打包后上传" });
    }

    const fileResults = analyzeZipBuffer(file.buffer, file.originalname || "archive.zip");
    const stats = summarizeZipResults(fileResults);

    res.json({
      mode: "zip",
      zipName: file.originalname || "archive.zip",
      ...stats,
      files: fileResults
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 简易修复：直接粘贴 Liquid 代码 + 描述问题 → 知识库匹配 + AI 修复 */
app.post("/api/simple-fix", async (req, res) => {
  try {
    const liquidCode = typeof req.body?.liquid_code === "string" ? req.body.liquid_code.trim() : "";
    const issueText = typeof req.body?.issue_text === "string" ? req.body.issue_text.trim() : "";
    if (!liquidCode) {
      return res.status(400).json({ error: "请提供 Liquid 代码" });
    }
    const result = await callOpenrouterFix(liquidCode, issueText || "综合性能优化");
    res.json({
      fixedCode: result.fixedCode || "",
      solution: result.appliedSolutions || "",
      error: result.error || ""
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.PAGE_SPEED_API_KEY) });
});

app.get("/api/config", (_req, res) => {
  const psiTimeoutMs = getPsiFetchTimeoutMs();
  res.json({
    psiTimeoutMs,
    psiTimeoutMinMs: 120_000,
    psiTimeoutMaxMs: 300_000
  });
});

const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, () => {
  console.log(`me-perfAI http://localhost:${port}`);
});
/** 避免长时间分析被底层过早断开（与 PSI 2～5 分钟等待一致，多 URL 累计） */
server.timeout = Math.max(server.timeout || 0, getPsiFetchTimeoutMs() * 6 + 120_000);
server.headersTimeout = Math.max(server.headersTimeout || 0, server.timeout + 30_000);
