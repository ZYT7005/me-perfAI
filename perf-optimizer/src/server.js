import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

// ── 知识库加载 ─────────────────────────────────────────────────
function loadKb() {
  const kbPath = path.join(root, "knowledge_base.json");
  if (!fs.existsSync(kbPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(kbPath, "utf-8"));
  } catch {
    return [];
  }
}

function matchKbEntries(issueText) {
  const kb = loadKb();
  const lower = (issueText || "").toLowerCase();
  const matched = kb.filter(item =>
    (item.issue_aliases || []).some(alias => lower.includes(alias.toLowerCase()))
  );
  return matched.length ? matched : getFallback();
}

function getFallback() {
  return [{
    id: "generic-fallback",
    shopify_scope: ["Liquid 模板结构精简", "图片与静态资源加载策略优化", "脚本按需加载与首屏优先"],
    solution: ["减少首屏阻塞资源，优先保障关键渲染路径。", "图片按尺寸输出，非关键图片懒加载。", "脚本按需加载并减少主线程阻塞。"]
  }];
}

function buildKbText(entries) {
  return entries.map(e => {
    const lines = [`【问题类型】${e.id}`, "【Shopify可优化范围】"];
    (e.shopify_scope || []).forEach(s => lines.push(`- ${s}`));
    lines.push("【优化方案】");
    (e.solution || []).forEach(s => lines.push(`- ${s}`));
    return lines.join("\n");
  }).join("\n\n");
}

// ── 1. PageSpeed 代理 ──────────────────────────────────────────
app.post("/api/pagespeed", async (req, res) => {
  try {
    const { url, strategy = "mobile" } = req.body || {};
    if (!url) return res.status(400).json({ error: "请提供目标 URL" });

    const apiKey = process.env.PAGE_SPEED_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "服务端未配置 PAGE_SPEED_API_KEY" });

    const params = new URLSearchParams({ url, key: apiKey, strategy, category: "performance" });
    const psRes = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
      signal: AbortSignal.timeout(120_000)
    });
    const data = await psRes.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const audits = data.lighthouseResult?.audits || {};
    const relevantKeys = [
      "largest-contentful-paint-element",
      "render-blocking-resources",
      "uses-optimized-images",
      "uses-responsive-images",
      "unminified-javascript",
      "unminified-css",
      "largest-contentful-paint",
      "first-contentful-paint",
      "cumulative-layout-shift",
      "total-blocking-time"
    ];
    const report = {};
    for (const k of relevantKeys) {
      if (audits[k]) report[k] = audits[k];
    }

    res.json({ report, categories: data.lighthouseResult?.categories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2. AI 分析接口（知识库增强 + OpenRouter）──────────────────
app.post("/api/analyze-sections", async (req, res) => {
  try {
    const { psiReport, sections } = req.body || {};
    if (!sections || !sections.length) return res.status(400).json({ error: "请提供 sections 内容" });

    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || "qwen/qwen3-235b-a22b";

    // 从 PSI 报告提取问题文字，用于知识库匹配
    const issueText = Object.entries(psiReport || {})
      .map(([k, v]) => v?.title || k)
      .join(", ");

    const kbEntries = matchKbEntries(issueText);
    const kbText = buildKbText(kbEntries);

    const allSectionsContext = sections.map(s => `--- FILE: ${s.path} ---\n${s.content}`).join("\n\n");

    const systemPrompt = `你是一个资深前端性能优化专家，精通 Shopify 主题开发架构。
你将收到：1. PageSpeed 性能诊断数据。2. 知识库优化方案。3. 被选中的多个源文件。
你的任务是：
1. 基于知识库方案和 PSI 数据，定位源文件中具体的性能隐患。
2. 对文件代码进行针对性优化（如：LCP 图片加 fetchpriority="high"，移除渲染阻塞资源等）。
3. 严格输出格式：先输出 Markdown 分析说明，然后使用以下格式块输出修改后的完整文件内容：
[[[实际修改文件的路径]]]
\`\`\`liquid
完整替换后的代码（不可省略任何内容）
\`\`\``;

    const userPrompt = `【PageSpeed 性能诊断数据】
${JSON.stringify(psiReport, null, 2)}

【知识库优化方案】
${kbText}

【源码文件内容】
${allSectionsContext}

请执行最优化的重构，并按格式输出。`;

    if (!apiKey) {
      return res.status(500).json({ error: "服务端未配置 OPENROUTER_API_KEY" });
    }

    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://perf-optimizer.onrender.com",
        "X-Title": "perf-optimizer"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 8192
      }),
      signal: AbortSignal.timeout(120_000)
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(500).json({ error: `AI 调用失败: ${aiRes.status} - ${t.slice(0, 300)}` });
    }

    const aiData = await aiRes.json();
    const reply = aiData.choices?.[0]?.message?.content || "";

    res.json({ reply, appliedKb: kbEntries.map(e => e.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasPsi: Boolean(process.env.PAGE_SPEED_API_KEY), hasAi: Boolean(process.env.OPENROUTER_API_KEY) });
});

const port = Number(process.env.PORT) || 3002;
app.listen(port, () => console.log(`perf-optimizer http://localhost:${port}`));
