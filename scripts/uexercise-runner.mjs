#!/usr/bin/env node
/**
 * Standalone uexercise unit-test runner.
 *
 * This is intentionally outside the Courseflow module: unit tests are served by
 * the separate uexercise.unipus.cn application, not by the normal courseware
 * task endpoints.
 *
 * Typical use:
 *   node scripts/uexercise-runner.mjs --storage-state u-storage.json \
 *     --courseware-url "https://ucontent.unipus.cn/..." --dump --out questions.json
 *
 *   node scripts/uexercise-runner.mjs --storage-state u-storage.json \
 *     --courseware-url "https://ucontent.unipus.cn/..." \
 *     --answers answers.json --submit
 */
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = { submit: false, headed: false, channel: 'msedge' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (['submit', 'headed', 'help', 'dump', 'generate', 'heuristic'].includes(name)) {
      out[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${key} 缺少值`);
    out[name] = value;
  }
  return out;
}

function usage() {
  console.log(`uexercise runner

  --exam-url <url>          直接打开已签名的 enter_unit_test URL
  --courseware-url <url>    打开课件页并自动触发“开始做题/继续答题”
  --storage-state <file>    Playwright storageState（推荐）
  --username <name>         U校园账号（也可用 UNIPUS_USERNAME）
  --password <password>     U校园密码（也可用 UNIPUS_PASSWORD）
  --save-state <file>       登录后保存 storageState
  --answers <file>          答案 JSON：{ "1": "A" } 或 { "1": "选项原文" }
  --generate                下载音频、ASR、AI 生成答案
  --answers-out <file>      生成答案输出，默认 uexercise-answers.json
  --transcripts-out <file>  保存 ASR 转写 JSON
  --asr-model <name>        faster-whisper 模型，默认 base.en
  --asr-python <path>       默认 python
  --ai-base <url>           OpenAI 兼容地址，如 https://api.siliconflow.cn/v1
  --ai-key <key>            AI Key；也可用 UEX_AI_KEY
  --ai-model <name>         AI 模型名
  --heuristic               不调用 AI，使用关键词匹配兜底
  --dump                    只解析题目，输出 JSON
  --out <file>              dump 输出文件，默认 stdout
  --submit                  真正交卷；不加时只填答案/演练
  --headed                  显示浏览器
  --channel <name>          msedge/chrome，默认 msedge
  --help                    显示帮助
`);
}

async function dismissOverlays(page) {
  for (let i = 0; i < 6; i += 1) {
    const clicked = await page.evaluate(() => {
      const visible = (n) => n && n.offsetParent !== null;
      const know = Array.from(document.querySelectorAll('*')).find(
        (n) => n.children.length === 0 && visible(n) && (n.textContent || '').trim() === '我知道了',
      );
      if (know) { know.click(); return true; }
      const ok = Array.from(document.querySelectorAll('*')).find(
        (n) => n.children.length === 0 && visible(n) && (n.textContent || '').trim() === '确定',
      );
      if (ok) { ok.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await page.waitForTimeout(500);
  }
}

async function loginIfNeeded(page, username, password) {
  if (!(await page.locator('[name="username"]').count())) return false;
  if (!username || !password) throw new Error('需要登录：请提供 --storage-state 或 --username/--password');
  await page.locator('[name="username"]').fill(username);
  await page.locator('[name="password"]').fill(password);
  const boxes = page.locator('[type="checkbox"]');
  if (await boxes.count() >= 2) await boxes.nth(1).click();
  await page.locator('.btn.btn-login.btn-fill').click();
  await page.waitForTimeout(4000);
  if ((await page.evaluate(() => document.body.innerText)).includes('另一台设备')) {
    await page.getByText('重新登录', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(password);
    const again = page.locator('[type="checkbox"]');
    if (await again.count() >= 2) await again.nth(1).click();
    await page.locator('.btn.btn-login.btn-fill').click();
    await page.waitForTimeout(4000);
  }
  return true;
}

async function resolveExamUrl(page, coursewareUrl) {
  await page.goto(coursewareUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  await dismissOverlays(page);
  const triggered = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const text = (b.innerText || '').trim();
      return /开始做题|继续答题|继续考试|开始考试/.test(text) || String(b.className).includes('toDoButton');
    });
    if (!btn) return false;
    const key = Object.keys(btn).find((k) => k.startsWith('__react'));
    let element = key ? btn[key]?._currentElement : null;
    for (let i = 0; i < 8 && element; i += 1) {
      const owner = element._owner;
      const instance = owner?._instance;
      if (instance?.todoSubject) {
        instance.todoSubject({ stopPropagation() {} });
        return true;
      }
      element = owner?._currentElement ?? null;
    }
    btn.click();
    return true;
  });
  if (!triggered) throw new Error('没有找到“开始做题/继续答题”按钮');
  await page.waitForTimeout(4000);
  let src = await page.evaluate(() => document.querySelector('#iframe')?.src ?? null);
  if (!src) {
    await page.waitForTimeout(4000);
    src = await page.evaluate(() => document.querySelector('#iframe')?.src ?? null);
  }
  if (!src) throw new Error('课件页没有生成 uexercise iframe');
  return src;
}

async function readExam(page) {
  return page.evaluate(() => {
    const form = document.querySelector('#submitAnswerForm');
    const groups = new Map();
    for (const input of document.querySelectorAll('input[type="radio"]')) {
      const index = String(input.getAttribute('qIndex') ?? '');
      if (!index) continue;
      if (!groups.has(index)) {
        groups.set(index, {
          index,
          qid: String(input.getAttribute('qid') ?? ''),
          type: 'radio',
          options: [],
        });
      }
      const label = input.closest('label');
      groups.get(index).options.push({
        value: String(input.value),
        text: (label?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
    for (const input of document.querySelectorAll('input[type="text"], textarea')) {
      const index = String(input.getAttribute('qIndex') ?? '');
      if (!index) continue;
      groups.set(index, {
        index,
        qid: String(input.getAttribute('qid') ?? ''),
        type: input.tagName === 'TEXTAREA' ? 'textarea' : 'text',
        placeholder: input.getAttribute('placeholder') ?? '',
      });
    }
    const questions = [...groups.values()].sort((a, b) => Number(a.index) - Number(b.index));
    const audio = Array.from(document.querySelectorAll('.itest-hear-reslist span'))
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean);
    const sections = Array.from(document.querySelectorAll('.itest-section')).map((section) => {
      const sectionAudio = Array.from(section.querySelectorAll('.itest-hear-reslist span'))
        .map((node) => (node.textContent || '').trim())
        .filter(Boolean);
      const questionSets = Array.from(section.querySelectorAll('.itest-ques-set')).map((set) => {
        const inputs = Array.from(set.querySelectorAll('input[type="radio"], input[type="text"], textarea'));
        const indexes = [...new Set(inputs.map((input) => input.getAttribute('qIndex')).filter(Boolean))];
        return {
          qid: set.getAttribute('questionid') ?? '',
          indexes,
          audio: Array.from(set.querySelectorAll('.itest-hear-reslist span'))
            .map((node) => (node.textContent || '').trim())
            .filter(Boolean),
        };
      });
      return {
        sectionId: section.getAttribute('sectionId') ?? '',
        sectionType: section.getAttribute('sectionType') ?? '',
        title: (section.querySelector('.title')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        audio: sectionAudio,
        questions: questionSets,
      };
    });
    return {
      url: location.href,
      title: document.title,
      formAction: form?.getAttribute('action') ?? '',
      sppid: document.querySelector('#sppid')?.value ?? '',
      exerciseId: document.querySelector('#exerciseId')?.value ?? '',
      questionCount: questions.length,
      questions,
      audio,
      sections,
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
    };
  });
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

async function fillAnswers(page, answers) {
  return page.evaluate((answerMap) => {
    const result = { radio: 0, text: 0, missing: [] };
    const setValue = (input, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      descriptor?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    };
    for (const [index, raw] of Object.entries(answerMap)) {
      const wanted = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const radios = Array.from(document.querySelectorAll(`input[type="radio"][qIndex="${index}"]`));
      if (radios.length) {
        for (const answer of wanted) {
          const target = radios.find((input) => {
            const label = input.closest('label');
            const text = (label?.innerText ?? '').replace(/\s+/g, ' ').trim();
            if (input.value === answer) return true;
            if (/^[A-Za-z]$/.test(answer)) {
              return new RegExp(`^${answer}[.、\\s]`, 'i').test(text);
            }
            return text.toLowerCase().includes(answer.toLowerCase());
          });
          if (target) {
            target.click();
            result.radio += 1;
          } else {
            result.missing.push({ index, answer });
          }
        }
        continue;
      }
      const input = document.querySelector(`input[type="text"][qIndex="${index}"], textarea[qIndex="${index}"]`);
      if (input) {
        setValue(input, wanted[0] ?? '');
        result.text += 1;
      } else {
        result.missing.push({ index, answer: wanted.join(',') });
      }
    }
    return result;
  }, answers);
}

async function submitExam(page) {
  await dismissOverlays(page);
  const responsePromise = page.waitForResponse(
    (r) => /\/itest\/s\/clsanswer\/submitUT/.test(r.url()),
    { timeout: 30000 },
  ).catch(() => null);
  await page.evaluate(() => {
    if (typeof paperSubmit === 'function') paperSubmit(1);
    else document.querySelector('#submit-answer')?.click();
  });
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(1000);
    const clicked = await page.evaluate(() => {
      const visible = (n) => n && n.offsetParent !== null;
      const button = Array.from(document.querySelectorAll('.layui-layer-btn0, .layui-layer-btn a, button, span'))
        .find((n) => visible(n) && (n.textContent || '').trim() === '确认');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) break;
  }
  const response = await responsePromise;
  let body = '';
  if (response) {
    try { body = (await response.text()).slice(0, 2000); } catch {}
  }
  await page.waitForTimeout(8000);
  return {
    status: response?.status() ?? 0,
    body,
    url: page.url(),
    text: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(-1000),
  };
}

function parseAudioGroup(value) {
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string' && /^https?:/.test(item));
  } catch {}
  return /^https?:/.test(String(value)) ? [String(value)] : [];
}

function collectAudioUrls(details) {
  const urls = [];
  for (const group of details.audio ?? []) urls.push(...parseAudioGroup(group));
  for (const section of details.sections ?? []) {
    for (const group of section.audio ?? []) urls.push(...parseAudioGroup(group));
    for (const question of section.questions ?? []) {
      for (const group of question.audio ?? []) urls.push(...parseAudioGroup(group));
    }
  }
  return [...new Set(urls)];
}

async function downloadAudios(urls, directory) {
  const manifest = [];
  const byUrl = new Map();
  for (const url of urls) {
    if (byUrl.has(url)) continue;
    const id = `a${byUrl.size + 1}`;
    const path = join(directory, `${id}.mp3`);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      byUrl.set(url, id);
      manifest.push({ id, path, url });
    } catch (error) {
      console.error(`audio download failed ${url}: ${error.message}`);
    }
  }
  return { manifest, byUrl };
}

async function transcribeAudios(manifest, args) {
  if (manifest.length === 0) return {};
  const script = fileURLToPath(new URL('./transcribe_many.py', import.meta.url));
  const manifestPath = `${manifest[0].path}.manifest.json`;
  const outputPath = `${manifest[0].path}.transcripts.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const python = args['asr-python'] ?? 'python';
  const model = args['asr-model'] ?? 'base.en';
  await new Promise((resolve, reject) => {
    const child = spawn(python, [script, manifestPath, outputPath, model], {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        HF_ENDPOINT: process.env.HF_ENDPOINT || process.env.CF_ASR_HF_ENDPOINT || 'https://hf-mirror.com',
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ASR timeout'));
    }, Number(args['asr-timeout'] ?? 300000));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ASR exit ${code}`));
    });
  });
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

function transcriptsByUrl(details, manifest, transcripts) {
  const map = new Map();
  for (const item of manifest) map.set(item.url, transcripts[item.id] ?? '');
  return map;
}

function questionTranscripts(details, byUrl) {
  const map = {};
  const all = [...byUrl.values()].filter(Boolean).join(' ');
  for (const section of details.sections ?? []) {
    const sectionText = (section.audio ?? [])
      .flatMap(parseAudioGroup)
      .map((url) => byUrl.get(url) ?? '')
      .filter(Boolean)
      .join(' ');
    for (const question of section.questions ?? []) {
      const questionText = (question.audio ?? [])
        .flatMap(parseAudioGroup)
        .map((url) => byUrl.get(url) ?? '')
        .filter(Boolean)
        .join(' ');
      const text = questionText || sectionText || all;
      for (const index of question.indexes ?? []) map[index] = text;
    }
  }
  return map;
}

function buildAiPrompt(details, byUrl) {
  const transcripts = [...byUrl.entries()]
    .filter(([, text]) => text)
    .map(([url, text], index) => `[T${index + 1}] ${text}`)
    .join('\n');
  const questions = details.questions.map((question) => ({
    index: question.index,
    type: question.type,
    options: question.options?.map((option) => option.text) ?? [],
  }));
  return [
    '你是 U校园单元测试答题助手。',
    '根据听力转写和题目，给出每道题的答案。',
    '选择题返回页面显示的选项字母（A/B/C/D）；填空题返回要填入的文本。',
    '只输出一个 JSON 对象，key 是题号，value 是答案字符串，例如 {"1":"D","16":"word"}。',
    '题目：',
    JSON.stringify(questions),
    '听力转写：',
    transcripts,
  ].join('\n');
}

async function callAi(args, prompt) {
  const base = args['ai-base'] ?? process.env.UEX_AI_BASE;
  const key = args['ai-key'] ?? process.env.UEX_AI_KEY;
  const model = args['ai-model'] ?? process.env.UEX_AI_MODEL;
  if (!base || !key || !model) return null;
  const endpoint = base.endsWith('/chat/completions') ? base : `${base.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是课程答题助手，只输出合法 JSON。' },
        { role: 'user', content: prompt },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AI HTTP ${response.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const content = String(data.choices?.[0]?.message?.content ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 没有返回 JSON');
  const parsed = JSON.parse(content.slice(start, end + 1));
  const out = {};
  for (const [keyName, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || Array.isArray(value)) out[String(keyName)] = value;
  }
  return Object.keys(out).length ? out : null;
}

function heuristicAnswers(details, byUrl) {
  const byQuestion = questionTranscripts(details, byUrl);
  const answers = {};
  for (const question of details.questions) {
    const transcript = String(byQuestion[question.index] ?? '').toLowerCase();
    if (question.type === 'radio') {
      let best = null;
      let bestScore = -1;
      for (const option of question.options ?? []) {
        const text = option.text.replace(/^[A-Z][.、]\s*/i, '').toLowerCase();
        const tokens = text.split(/[^a-z0-9']+/).filter((token) => token.length > 2);
        const score = tokens.reduce((sum, token) => sum + (transcript.includes(token) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; best = option; }
      }
      const letter = String(best?.text ?? '').match(/^([A-Z])[.、]/i)?.[1] ?? 'A';
      answers[question.index] = letter.toUpperCase();
    } else {
      answers[question.index] = '';
    }
  }
  return answers;
}

async function generateAnswers(details, args) {
  const urls = collectAudioUrls(details);
  const directory = mkdtempSync(join(tmpdir(), 'uexercise-audio-'));
  try {
    const { manifest, byUrl } = await downloadAudios(urls, directory);
    console.error(`audio: ${manifest.length} file(s)`);
    const transcripts = await transcribeAudios(manifest, args);
    if (args['transcripts-out']) writeFileSync(args['transcripts-out'], JSON.stringify(transcripts, null, 2));
    const transcriptMap = transcriptsByUrl(details, manifest, transcripts);
    let answers = null;
    if (!args.heuristic) {
      try {
        answers = await callAi(args, buildAiPrompt(details, transcriptMap));
      } catch (error) {
        console.error(`AI failed: ${error.message}`);
      }
    }
    if (!answers) {
      console.error('using heuristic answer fallback');
      answers = heuristicAnswers(details, transcriptMap);
    }
    const output = args['answers-out'] ?? 'uexercise-answers.json';
    writeFileSync(output, JSON.stringify(answers, null, 2));
    console.log(`answers written to ${output} (${Object.keys(answers).length})`);
    return answers;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const username = args.username ?? process.env.UNIPUS_USERNAME ?? '';
  const password = args.password ?? process.env.UNIPUS_PASSWORD ?? '';
  const browser = await chromium.launch({
    headless: !args.headed,
    channel: args.channel,
  });
  const context = await browser.newContext({
    ...(args['storage-state'] ? { storageState: args['storage-state'] } : {}),
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  await page.goto('https://u.unipus.cn/user/student?school_id=8979', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const loggedIn = await loginIfNeeded(page, username, password);
  if (loggedIn) {
    await page.waitForTimeout(1500);
    if (args['save-state']) await context.storageState({ path: args['save-state'] });
  }
  let examUrl = args['exam-url'];
  if (!examUrl) {
    if (!args['courseware-url']) throw new Error('需要 --exam-url 或 --courseware-url');
    examUrl = await resolveExamUrl(page, args['courseware-url']);
  }
  const exam = await context.newPage();
  await exam.goto(examUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await exam.waitForSelector('#submitAnswerForm, .itest-section', { timeout: 30000 });
  await exam.waitForTimeout(2000);
  await dismissOverlays(exam);
  await exam.waitForTimeout(800);
  const details = await readExam(exam);
  let answers = null;
  if (args.generate) {
    answers = await generateAnswers(details, args);
  } else if (args.answers) {
    answers = JSON.parse(readFileSync(args.answers, 'utf8'));
  }
  if (args.dump || !answers) {
    const text = JSON.stringify(details, null, 2);
    if (args.out) writeFileSync(args.out, text);
    else console.log(text);
    if (!answers) {
      await browser.close();
      return;
    }
  }
  const filled = await fillAnswers(exam, answers);
  console.log(`filled radio=${filled.radio} text=${filled.text} missing=${JSON.stringify(filled.missing)}`);
  if (!args.submit) {
    console.log('dry-run: 未提交。加 --submit 才会交卷。');
    await browser.close();
    return;
  }
  const submitted = await submitExam(exam);
  console.log(JSON.stringify({ filled, submitted }, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
