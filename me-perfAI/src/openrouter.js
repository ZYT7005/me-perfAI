import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadKbData() {
  const kbPath = path.join(__dirname, "knowledge_base.json");
  const raw = fs.readFileSync(kbPath, "utf-8");
  return JSON.parse(raw);
}

function getFallbackEntry() {
  return [
    {
      id: "generic-fallback",
      issue_aliases: [],
      shopify_scope: [
        "Liquid 模板结构精简",
        "图片与静态资源加载策略优化",
        "脚本按需加载与首屏优先"
      ],
      solution: [
        "减少首屏阻塞资源，优先保障关键渲染路径。",
        "图片按尺寸输出，非关键图片懒加载。",
        "脚本按需加载并减少主线程阻塞。"
      ]
    }
  ];
}

function buildSolutionText(entries) {
  const lines = [];
  for (const entry of entries) {
    lines.push(`【问题类型】\${entry.id}`);
    lines.push("【Shopify可优化范围】");
    for (const scope of entry.shopify_scope) {
      lines.push(`- \${scope}`);
    }
    lines.push("【优化方案】");
    for (const step of entry.solution) {
      lines.push(`- \${step}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function callOpenrouterMatchKb(liquidCode, issueText) {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const model = process.env.OPENROUTER_MODEL || "qwen/qwen3.6-plus";

  const kbData = loadKbData();

  function defaultMatch() {
    const issueLower = issueText.toLowerCase();
    const matched = [];
    for (const item of kbData) {
      const aliases = item.issue_aliases || [];
      if (aliases.some(alias => issueLower.includes(alias.toLowerCase()))) {
        matched.push(item);
      }
    }
    return matched.length > 0 ? matched : getFallbackEntry();
  }

  if (!apiKey) {
    return defaultMatch();
  }

  const kbSummaries = [];
  for (const item of kbData) {
    const aliases = (item.issue_aliases || []).join(", ");
    const scope = (item.shopify_scope || []).join(", ");
    kbSummaries.push(`ID: \${item.id}\nAliases: \${aliases}\nScope: \${scope}`);
  }
  const kbText = kbSummaries.join("\n\n");

  const systemPrompt = `你是性能优化知识库的分类引擎。
你的任务是根据用户提供的 Liquid 代码和性能问题，从给定的知识库列表中挑选出匹配的问题 ID。
请只返回一个严格的 JSON 数组，包含所有匹配的 ID（如果无匹配项则返回空数组 []）。
请不要输出任何多余的文本、解释或 Markdown 标记，确保结果可以被 json.loads 直接解析。
例如：["lcp-discovery-timing"]`;

  const userPrompt = `【知识库列表】
\${kbText}

【待分析的 Liquid 代码】
\${liquidCode.slice(0, 10000)}

【用户反馈的性能问题】
\${issueText}

请结合代码和上述问题，返回最匹配此代码中待优化部分的知识库 ID（可多选）。输出严格为 JSON 数组格式：`;

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer \${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3001/",
        "X-Title": "shopify-liquid-performance-fixer",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      })
    });

    if (!resp.ok) {
      return defaultMatch();
    }

    const data = await resp.json();
    let content = (data.choices?.[0]?.message?.content || "").trim();

    if (content.startsWith("\`\`\`json")) {
      content = content.slice(7, -3).trim();
    } else if (content.startsWith("\`\`\`")) {
      content = content.slice(3, -3).trim();
    }

    let matchedIds = [];
    try {
      matchedIds = JSON.parse(content);
    } catch {
      matchedIds = [];
    }

    if (!Array.isArray(matchedIds)) {
      matchedIds = [];
    }

    const matchedEntries = kbData.filter(item => matchedIds.includes(item.id));
    return matchedEntries.length > 0 ? matchedEntries : getFallbackEntry();
  } catch (err) {
    console.error("OpenRouter Match Error:", err);
    return defaultMatch();
  }
}

export async function callOpenrouterFix(liquidCode, issueText) {
  const matchedEntries = await callOpenrouterMatchKb(liquidCode, issueText);
  const optimizationSolution = buildSolutionText(matchedEntries);

  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const model = process.env.OPENROUTER_MODEL || "qwen/qwen3.6-plus";

  if (!apiKey) {
    return {
      fixedCode: "",
      error: "未配置 OPENROUTER_API_KEY，请先在环境变量中配置。"
    };
  }

  const systemPrompt = `你是资深 Shopify Liquid 性能优化工程师。
你会基于性能问题和优化知识库方案，直接修改 Liquid 代码并输出可用版本。
只返回修复后的 Liquid 代码，不要解释，不要使用 Markdown 语法包装代码片段。直接返回纯代码。`;

  const userPrompt = `【待修复 Liquid 代码】
\${liquidCode}

【PageSpeed 性能问题】
\${issueText}

【知识库优化方案】
\${optimizationSolution}

请输出修复后的完整 Liquid 代码。`;

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer \${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3001/",
        "X-Title": "shopify-liquid-performance-fixer",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 4096
      }),
      // timeout: 60000 
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        fixedCode: "",
        error: `OpenRouter 调用失败: \${resp.status} - \${text}`
      };
    }

    const data = await resp.json();
    let content = (data.choices?.[0]?.message?.content || "").trim();
    if (content.startsWith("\`\`\`liquid")) {
        content = content.slice(9, -3).trim();
    } else if (content.startsWith("\`\`\`html")) {
        content = content.slice(7, -3).trim();
    } else if (content.startsWith("\`\`\`")) {
        content = content.slice(3, -3).trim();
    }

    return {
      fixedCode: content,
      error: "",
      appliedSolutions: optimizationSolution
    };
  } catch (err) {
    console.error("OpenRouter Fix Error:", err);
    return {
      fixedCode: "",
      error: `请求异常: \${err.message}`
    };
  }
}
