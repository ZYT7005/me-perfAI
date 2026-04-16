// State
let currentPsiReport = null;
let globalZip = null;
let uploadedTemplates = {};
let uploadedSections = {};
let currentJsonContent = '';
let currentRelatedSections = [];
let modifiedFileName = null;
let optimizedCodeStr = null;
let originalZipName = 'optimized-theme.zip';

const targetUrlInput = document.getElementById('target-url');
const strategySelect = document.getElementById('strategy-select');
const fetchPsiBtn = document.getElementById('fetch-psi-btn');
const lcpStatusHint = document.getElementById('lcp-status-hint');
const lcpResult = document.getElementById('lcp-result');
const psiSummary = document.getElementById('psi-summary');
const lcpSnippet = document.getElementById('lcp-snippet');

const folderDropArea = document.getElementById('folder-drop-area');
const folderUploadInput = document.getElementById('folder-upload');
const folderAnalysisUi = document.getElementById('folder-analysis-ui');
const templateSelect = document.getElementById('template-select');
const sectionListUi = document.getElementById('section-list-ui');
const sectionCheckboxes = document.getElementById('section-checkboxes');
const startAnalysisBtn = document.getElementById('start-analysis-btn');

const step3 = document.getElementById('step3');
const kbApplied = document.getElementById('kb-applied');
const kbAppliedList = document.getElementById('kb-applied-list');
const aiAnalysisText = document.getElementById('ai-analysis-text');
const diffViewArea = document.getElementById('diff-view-area');
const modFileName = document.getElementById('mod-file-name');
const originalCodeArea = document.getElementById('original-code');
const optimizedCodeArea = document.getElementById('optimized-code');
const acceptOptCheck = document.getElementById('accept-opt');
const copyCodeBtn = document.getElementById('copy-code-btn');
const downloadZipBtn = document.getElementById('download-zip-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

function checkEnableAnalysisBtn() {
    startAnalysisBtn.disabled = !(currentPsiReport && currentJsonContent);
}

function showLoading(msg) {
    loadingText.textContent = msg;
    loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

// ── 步骤 1：PageSpeed 诊断（走后端代理）────────────────────────
fetchPsiBtn.addEventListener('click', handleUrlInput);
targetUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUrlInput(); });

async function handleUrlInput() {
    let url = targetUrlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    lcpStatusHint.textContent = '⏳ 正在通过服务端调用 PageSpeed API...';
    lcpStatusHint.style.color = 'var(--primary)';
    fetchPsiBtn.disabled = true;
    lcpResult.classList.add('hidden');

    try {
        const res = await fetch('/api/pagespeed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, strategy: strategySelect.value })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        currentPsiReport = data.report;
        checkEnableAnalysisBtn();

        // 渲染汇总卡片
        psiSummary.innerHTML = '';
        const keyLabels = {
            'largest-contentful-paint': 'LCP',
            'first-contentful-paint': 'FCP',
            'cumulative-layout-shift': 'CLS',
            'total-blocking-time': 'TBT'
        };
        for (const [k, label] of Object.entries(keyLabels)) {
            const audit = currentPsiReport[k];
            if (!audit) continue;
            const score = audit.score != null ? Math.round(audit.score * 100) : null;
            const color = score == null ? '#6B7280' : score >= 90 ? '#10B981' : score >= 50 ? '#F59E0B' : '#EF4444';
            const card = document.createElement('div');
            card.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;';
            card.innerHTML = `<span style="font-weight:700;font-size:1.1rem;color:${color};">${score != null ? score : '—'}</span>`
                + `<span style="font-weight:600;color:#374151;">${label}</span>`
                + `<span style="color:#6B7280;font-size:0.85rem;margin-left:auto;">${audit.displayValue || ''}</span>`;
            psiSummary.appendChild(card);
        }

        lcpSnippet.textContent = JSON.stringify(currentPsiReport, null, 2);
        lcpResult.classList.remove('hidden');
        lcpStatusHint.textContent = '✅ 性能诊断数据获取成功！';
        lcpStatusHint.style.color = 'var(--secondary)';
    } catch (err) {
        lcpStatusHint.textContent = '❌ 获取失败：' + err.message;
        lcpStatusHint.style.color = 'var(--error)';
    } finally {
        fetchPsiBtn.disabled = false;
    }
}

// ── 步骤 2：ZIP 上传解析（纯前端，不走后端）────────────────────
folderDropArea.addEventListener('click', (e) => {
    if (e.target !== folderUploadInput) folderUploadInput.click();
});
folderDropArea.addEventListener('dragover', (e) => { e.preventDefault(); folderDropArea.classList.add('dragover'); });
folderDropArea.addEventListener('dragleave', () => folderDropArea.classList.remove('dragover'));
folderDropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    folderDropArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) processZip(e.dataTransfer.files[0]);
});
folderUploadInput.addEventListener('change', async (e) => {
    if (e.target.files.length) {
        const f = e.target.files[0];
        try { await processZip(f); } finally { e.target.value = ''; }
    }
});

async function processZip(file) {
    if (!file || !file.name.endsWith('.zip')) return alert('请上传 .zip 格式的压缩包！');
    originalZipName = file.name.replace('.zip', '-optimized.zip');
    showLoading('正在挂载并扫描 ZIP 压缩包...');

    try {
        if (typeof JSZip === 'undefined') throw new Error('JSZip 库未能加载，请刷新重试。');
        globalZip = await JSZip.loadAsync(file);
        uploadedTemplates = {};
        uploadedSections = {};
        let foundAny = false;

        for (const [p, zipEntry] of Object.entries(globalZip.files)) {
            if (zipEntry.dir) continue;
            const norm = p.replace(/\\/g, '/');
            const lower = norm.toLowerCase();
            const segs = lower.split('/');
            const filename = norm.split('/').pop();

            if (segs.includes('templates') && lower.endsWith('.json')) {
                uploadedTemplates[filename] = { path: norm, entry: zipEntry };
                foundAny = true;
            } else if (segs.includes('sections') && (lower.endsWith('.liquid') || lower.endsWith('.json'))) {
                uploadedSections[filename] = { path: norm, entry: zipEntry };
                foundAny = true;
            }
        }

        if (!foundAny) return alert('压缩包中没有找到 templates/*.json 或 sections/*.liquid，请确认是 Shopify 主题包。');

        templateSelect.innerHTML = '<option value="">-- 请选择关联页面（如 index.json）--</option>';
        for (const name in uploadedTemplates) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            templateSelect.appendChild(opt);
        }

        folderAnalysisUi.classList.remove('hidden');
        currentJsonContent = '';
        sectionListUi.classList.add('hidden');

        const tCount = Object.keys(uploadedTemplates).length;
        const sCount = Object.keys(uploadedSections).length;
        alert(`压缩包加载完毕！找到 ${tCount} 个页面模板、${sCount} 个 Section 文件。请选择要优化的页面。`);
    } catch (e) {
        console.error('ZIP Error', e);
        alert('读取压缩包失败：' + e.message);
    } finally {
        hideLoading();
    }
}

templateSelect.addEventListener('change', async (e) => {
    const filename = e.target.value;
    if (!filename || !uploadedTemplates[filename]) return;

    sectionListUi.classList.remove('hidden');
    sectionCheckboxes.innerHTML = '正在分析组件依赖...';

    const fileEntry = uploadedTemplates[filename].entry;
    currentJsonContent = await fileEntry.async('string');

    try {
        const json = JSON.parse(currentJsonContent);
        const sectionsObj = json.sections || {};
        const types = new Set();
        for (const key in sectionsObj) {
            if (sectionsObj[key].type) types.add(sectionsObj[key].type);
        }

        currentRelatedSections = [];
        sectionCheckboxes.innerHTML = '';
        let foundCount = 0;

        for (const type of types) {
            for (const pn of [type + '.liquid', type + '.json']) {
                if (uploadedSections[pn]) {
                    const sec = uploadedSections[pn];
                    currentRelatedSections.push({ name: pn, path: sec.path, entry: sec.entry });
                    const lbl = document.createElement('label');
                    lbl.style.cssText = 'display:block;margin-bottom:6px;cursor:pointer;';
                    lbl.innerHTML = `<input type="checkbox" checked value="${pn}" style="margin-right:6px;"> ${pn} <span style="color:#aaa;font-size:0.8rem;">(${sec.path})</span>`;
                    sectionCheckboxes.appendChild(lbl);
                    foundCount++;
                }
            }
        }

        if (foundCount === 0) {
            sectionCheckboxes.innerHTML = '<span style="color:var(--error)">警告：未能在压缩包中找到该页面引用的任何 Section 文件。</span>';
        }

        checkEnableAnalysisBtn();
    } catch (err) {
        sectionCheckboxes.innerHTML = `<span style="color:var(--error)">JSON 解析失败：${err.message}</span>`;
    }
});

// ── 步骤 3：AI 分析（走后端，注入知识库）────────────────────────
startAnalysisBtn.addEventListener('click', async () => {
    const checkedInputs = Array.from(sectionCheckboxes.querySelectorAll('input:checked'));
    if (checkedInputs.length === 0) return alert('请至少勾选一个 Section 组件进行分析！');

    const checkedNames = checkedInputs.map(i => i.value);
    const targetSections = currentRelatedSections.filter(s => checkedNames.includes(s.name));

    showLoading('AI 正在基于知识库比对查勘及代码重构，请稍候（约 30～60 秒）...');
    step3.classList.add('hidden');
    diffViewArea.classList.add('hidden');
    kbApplied.classList.add('hidden');

    // 读取 section 文件内容（前端本地读取 ZIP）
    const sections = [];
    try {
        for (const s of targetSections) {
            const content = await s.entry.async('string');
            sections.push({ path: s.path, content });
        }
    } catch (e) {
        hideLoading();
        return alert('读取 Section 文件失败：' + e.message);
    }

    try {
        const res = await fetch('/api/analyze-sections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ psiReport: currentPsiReport || {}, sections })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const reply = data.reply || '';

        // 显示知识库命中情况
        if (data.appliedKb && data.appliedKb.length) {
            kbApplied.classList.remove('hidden');
            kbAppliedList.innerHTML = data.appliedKb.map(id =>
                `<span style="display:inline-block;background:#dcfce7;color:#166534;padding:2px 10px;border-radius:999px;margin:2px;font-size:0.82rem;">${id}</span>`
            ).join('');
        }

        // 解析 AI 回复中的代码块
        let displayStr = reply;
        const pMatch = reply.match(/\[\[\[(.*?)\]\]\]\n```[a-z]*\n([\s\S]*?)```/);

        if (pMatch) {
            modifiedFileName = pMatch[1].trim();
            optimizedCodeStr = pMatch[2].trim();
            displayStr = reply.replace(pMatch[0], '*代码已移至下方对比区域*');

            let origContent = '未找到原始代码';
            const tgtObj = targetSections.find(s => s.path === modifiedFileName || s.path.endsWith(modifiedFileName));
            if (tgtObj) {
                origContent = await tgtObj.entry.async('string');
                modifiedFileName = tgtObj.path;
            }

            modFileName.textContent = modifiedFileName;
            originalCodeArea.value = origContent;
            optimizedCodeArea.value = optimizedCodeStr;
            diffViewArea.classList.remove('hidden');
        } else {
            modifiedFileName = null;
            optimizedCodeStr = null;
        }

        aiAnalysisText.innerHTML = marked.parse(displayStr);
        step3.classList.remove('hidden');
        step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        alert('AI 分析出错：' + err.message);
    } finally {
        hideLoading();
    }
});

// ── 步骤 4：复制代码 & 打包下载 ZIP ─────────────────────────────
copyCodeBtn.addEventListener('click', () => {
    const text = optimizedCodeArea.value;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            const orig = copyCodeBtn.textContent;
            copyCodeBtn.textContent = '已复制 ✓';
            setTimeout(() => { copyCodeBtn.textContent = orig; }, 2000);
        });
    } else {
        optimizedCodeArea.select();
        document.execCommand('copy');
        const orig = copyCodeBtn.textContent;
        copyCodeBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyCodeBtn.textContent = orig; }, 2000);
    }
});

downloadZipBtn.addEventListener('click', async () => {
    if (!globalZip) return alert('未加载原始压缩包！');

    if (acceptOptCheck.checked && modifiedFileName && optimizedCodeStr) {
        globalZip.file(modifiedFileName, optimizedCodeStr);
    } else if (acceptOptCheck.checked) {
        return alert('AI 没有规范地输出可引用的代码块，无法直接替换。可手动复制优化后的代码。');
    }

    showLoading('正在打包全新的 ZIP 文件...');
    try {
        const blob = await globalZip.generateAsync({ type: 'blob' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = originalZipName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        alert('打包失败：' + err.message);
    } finally {
        hideLoading();
    }
});
