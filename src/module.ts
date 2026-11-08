import { createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MANIFEST = JSON.parse(
  readFileSync(new URL('./courseflow.module.json', import.meta.url), 'utf8'),
);

const SETTINGS = (() => {
  try {
    const parsed = JSON.parse(process.env.CF_MODULE_SETTINGS || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
})();

const SSO_BASE = 'https://sso.unipus.cn';
const UNIPUS_BASE =
  typeof SETTINGS.base_url === 'string' && SETTINGS.base_url.trim()
    ? SETTINGS.base_url.trim().replace(/\/$/, '')
    : 'https://u.unipus.cn';
const UCONTENT_BASE =
  typeof SETTINGS.content_base_url === 'string' && SETTINGS.content_base_url.trim()
    ? SETTINGS.content_base_url.trim().replace(/\/$/, '')
    : 'https://ucontent.unipus.cn';
const CLASS_URL =
  typeof SETTINGS.class_url === 'string' ? SETTINGS.class_url.trim() : '';
const COURSE_ID =
  typeof SETTINGS.course_id === 'string' ? SETTINGS.course_id.trim() : '';
const SCHOOL_ID = (() => {
  if (SETTINGS.school_id !== undefined && SETTINGS.school_id !== null) {
    return String(SETTINGS.school_id);
  }
  const match = CLASS_URL.match(/[?&]school_id=(\d+)/);
  return match ? match[1] : '';
})();
const CLASS_ID = (() => {
  const match = CLASS_URL.match(/[?&]classId=(\d+)/);
  return match ? match[1] : '';
})();
const DB_COURSE_ID = (() => {
  const match = CLASS_URL.match(/[?&]courseId=(\d+)/);
  return match ? match[1] : '';
})();
const BROWSER_STUDY = SETTINGS.browser_study !== false;
const ASR_ENABLED = SETTINGS.asr_enabled !== false;
const ASR_PYTHON =
  typeof SETTINGS.asr_python === 'string' && SETTINGS.asr_python.trim()
    ? SETTINGS.asr_python.trim()
    : 'python';
const ASR_MODEL =
  typeof SETTINGS.asr_model === 'string' && SETTINGS.asr_model.trim()
    ? SETTINGS.asr_model.trim()
    : 'base.en';
const ASR_TIMEOUT_MS = Number(SETTINGS.asr_timeout_ms ?? 24000);

const LOGIN_AES_KEY = Buffer.from('8AD70B641C024C7ADA2ECD082EC0334F', 'hex');
const LOGIN_AES_IV = Buffer.from('0102030405060708090A0B0C0D0E0F10', 'hex');
const CONTENT_KEY_PREFIX = '1a2b3c4d';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'user-agent': BROWSER_UA,
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

const write = (message: any) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (level: string, message: string) =>
  process.stderr.write(`[unipus-classic] ${level} ${message}\n`);

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function hostCall(method: string, params: any): Promise<any> {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  write({ jsonrpc: '2.0', id, method, params });
  return promise;
}

function errorText(error: any): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    return error.code ? `${error.code}: ${error.message}` : String(error.message ?? error);
  }
  return String(error);
}

function encryptLoginField(value: string): string {
  const cipher = createCipheriv('aes-128-cbc', LOGIN_AES_KEY, LOGIN_AES_IV);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

class HostResponse {
  status: number;
  ok: boolean;
  body: string;
  headers: { get(name: string): string | null };
  constructor(response: any) {
    this.status = Number(response?.status ?? 0);
    this.ok = this.status >= 200 && this.status < 300;
    this.body = typeof response?.body === 'string' ? response.body : '';
    const lower = new Map<string, string>();
    for (const [key, value] of Object.entries(response?.headers ?? {})) {
      lower.set(String(key).toLowerCase(), String(value));
    }
    this.headers = { get: (name: string) => lower.get(String(name).toLowerCase()) ?? null };
  }
  async text(): Promise<string> {
    return this.body;
  }
  async json(): Promise<any> {
    return JSON.parse(this.body);
  }
}

function hostFetchFor(session: string, stage = 'read') {
  return async (input: any, init: any = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    delete headers.cookie;
    delete headers.host;
    delete headers['content-length'];
    const rawBody = init.body;
    const body = rawBody === undefined || rawBody === null
      ? undefined
      : typeof rawBody === 'string'
        ? rawBody
        : String(rawBody);
    const response = await hostCall('cw.net.fetch', {
      session,
      method: String(init.method ?? 'GET').toUpperCase(),
      url,
      headers,
      ...(body !== undefined ? { body, encoding: 'raw' } : {}),
      stage: init.stage ?? stage,
    });
    return new HostResponse(response);
  };
}

async function follow(
  session: string,
  startUrl: string,
  maxHops = 8,
): Promise<{ url: string; response: HostResponse; body: string }> {
  const fetcher = hostFetchFor(session);
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await fetcher(url, {
      headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const location = response.headers.get('location');
    if (!location) return { url, response, body: await response.text() };
    url = new URL(location, url).toString();
  }
  const response = await hostFetchFor(session)(url);
  return { url, response, body: await response.text() };
}

// ------------------------------------------------------------------ auth

const challenges = new Map<string, any>();
let challengeSeq = 0;

async function describe(params: any) {
  log('info', `describe framework=${params.framework_version ?? ''}`);
  return {
    module: { name: 'courseflow-unipus-classic', version: MANIFEST.version, module_api: 1 },
    platform: MANIFEST.platform,
  };
}

function authBegin(params: any) {
  challengeSeq += 1;
  const id = String(params.session ?? `ch_unipus_classic_${challengeSeq}_${Date.now()}`);
  challenges.set(id, { state: 'waiting', at: Date.now() });
  return {
    challenge: {
      id,
      kind: 'password',
      expires_at: Math.floor(Date.now() / 1000) + 180,
      fields: [
        {
          name: 'username',
          label: 'U校园账号',
          type: 'text',
          required: true,
          autocomplete: 'username',
          placeholder: '手机号或邮箱',
        },
        {
          name: 'password',
          label: '密码',
          type: 'password',
          required: true,
          autocomplete: 'current-password',
        },
      ],
    },
  };
}

async function kickOtherSession(session: string): Promise<void> {
  try {
    log('warn', 'single-session conflict, logging out the other session');
    await follow(session, `${UNIPUS_BASE}/logout?school_id=${encodeURIComponent(SCHOOL_ID)}&repeatLogin=1`, 6);
    await follow(session, `${UNIPUS_BASE}/user/comm/login?school_id=`, 4);
  } catch (error) {
    log('warn', `logout other session failed: ${errorText(error)}`);
  }
}

async function casLogin(session: string, username: string, password: string) {
  const service = `${UNIPUS_BASE}/user/student?school_id=${encodeURIComponent(SCHOOL_ID)}`;
  const loginPage = `${SSO_BASE}/sso/login?service=${encodeURIComponent(service)}`;
  const fetcher = hostFetchFor(session);

  await fetcher(loginPage, {
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });

  const loginResponse = await fetcher(`${SSO_BASE}/sso/0.1/sso/cip/login`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      origin: SSO_BASE,
      referer: loginPage,
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: encryptLoginField(username),
      password: encryptLoginField(password),
      service,
      pcFlag: true,
      bindFlag: true,
      mfaCode: '',
    }),
  });
  let login: any;
  try {
    login = JSON.parse(loginResponse.body);
  } catch {
    throw new Error(`SSO 返回非 JSON（HTTP ${loginResponse.status}）`);
  }
  if (login.code === '1506') {
    throw { code: 'platform_verification_required', message: '平台要求图形/滑块验证码，请先在浏览器完成一次登录后重试' };
  }
  if (login.code !== '0') {
    throw new Error(`SSO 登录失败：code ${login.code ?? '?'} ${login.msg ?? ''}`.trim());
  }
  const ticket = login.rs?.serviceTicket;
  const openId = login.rs?.openid;
  if (!ticket) throw new Error('SSO 未返回 serviceTicket');
  return { service, ticket, openId, fetcher };
}

async function liveLogin(session: string, username: string, password: string) {
  if (!SCHOOL_ID) throw new Error('模块设置缺少 school_id（或在 class_url 中带上）');
  let lastError: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await kickOtherSession(session);
    const { service, ticket, openId, fetcher } = await casLogin(session, username, password);
    const redeem = `${service}${service.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
    await follow(session, redeem, 8);

    const tokenResponse = await fetcher(`${UNIPUS_BASE}/user/data/getToken`, {
      headers: { ...BROWSER_HEADERS, accept: 'application/json, text/plain, */*', referer: service },
    });
    if (tokenResponse.status === 302 || !tokenResponse.ok) {
      lastError = {
        code: 'platform_session_conflict',
        message: '账号已在其他设备/浏览器登录，自动退出后仍无法登录',
      };
      continue;
    }
    let tokenJson: any;
    try {
      tokenJson = JSON.parse(tokenResponse.body);
    } catch {
      throw new Error(`getToken 返回非 JSON（HTTP ${tokenResponse.status}）`);
    }
    const token = tokenJson.token ?? tokenJson.data?.token;
    const resolvedOpenId = tokenJson.openId ?? tokenJson.data?.openId ?? openId;
    if (!token) {
      lastError = { code: 'platform_session_conflict', message: 'getToken 未返回 token' };
      continue;
    }
    if (CLASS_ID && DB_COURSE_ID) {
      try {
        await fetcher(
          `${UNIPUS_BASE}/user/student/mycourse/automaticJoinClass?classId=${CLASS_ID}&now=${Date.now()}&courseId=${DB_COURSE_ID}`,
          {
            headers: {
              ...BROWSER_HEADERS,
              accept: 'text/html, */*; q=0.01',
              referer: service,
              'x-requested-with': 'XMLHttpRequest',
            },
          },
        );
      } catch (error) {
        log('warn', `automaticJoinClass failed: ${errorText(error)}`);
      }
    }
    return { token: String(token), openId: String(resolvedOpenId ?? ''), displayName: username };
  }
  throw lastError ?? { code: 'platform_session_conflict', message: '登录失败' };
}

async function authSubmit(params: any) {
  const id = String(params.challenge ?? '');
  const challenge = challenges.get(id);
  if (!challenge) return { state: 'expired' };
  const fields = params.fields && typeof params.fields === 'object' ? params.fields : {};
  const username = typeof fields.username === 'string' ? fields.username.trim() : '';
  const password = typeof fields.password === 'string' ? fields.password : '';
  if (!username || !password) return { state: 'failed', message: '请输入账号和密码' };

  try {
    const identity = await liveLogin(id, username, password);
    challenge.state = 'connected';
    challenge.identity = { display_name: identity.displayName, account_raw: identity.openId };
    await hostCall('cw.state', {
      session: id,
      namespace: 'auth',
      key: 'session',
      value: {
        token: identity.token,
        open_id: identity.openId,
        school_id: SCHOOL_ID,
        connected_at: Date.now(),
      },
    });
    log('info', `auth.submit connected openId=${identity.openId}`);
    return { state: 'connected' };
  } catch (error) {
    challenge.state = 'failed';
    challenge.message = errorText(error);
    log('warn', `auth.submit failed: ${challenge.message}`);
    return { state: 'failed', message: challenge.message };
  }
}

function authPoll(params: any) {
  const challenge = challenges.get(String(params.challenge ?? ''));
  return challenge ? { state: challenge.state } : { state: 'expired' };
}

function authComplete(params: any) {
  const id = String(params.challenge ?? '');
  const challenge = challenges.get(id);
  if (!challenge) throw { code: 'invalid_params', message: '登录挑战不存在' };
  const identity = challenge.identity;
  challenges.delete(id);
  if (!identity) throw { code: 'invalid_params', message: '登录尚未完成' };
  return identity;
}

async function authVerify(params: any) {
  try {
    const identity = await hostCall('cw.session.identity', { session: params.session });
    return {
      display_name: identity?.display_name ?? 'U校园普通版',
      account_raw: identity?.account_raw ?? '',
      connected_at: identity?.connected_at ?? null,
    };
  } catch {
    return { display_name: 'U校园普通版', account_raw: '' };
  }
}

async function authKeepalive(params: any) {
  try {
    const state = await readAuth(String(params.session ?? ''));
    return { ok: Boolean(state?.token), expires_at: null };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

async function readAuth(session: string): Promise<any> {
  const stored = await hostCall('cw.state', { session, namespace: 'auth', key: 'session' });
  const value = stored?.value;
  if (!value?.token) throw { code: 'platform_login_expired', message: '请先连接 U校园普通版' };
  return value;
}

// ------------------------------------------------------------------ course

function courseFromCatalog(html: string): { id: string; name: string } {
  const idMatch = html.match(/var\s+course_id\s*=\s*"([^"]+)"/);
  const titleMatch =
    html.match(/<h3>([^<]+)<\/h3>/) ??
    html.match(/<title>([^<]*)<\/title>/) ??
    [];
  if (!idMatch) throw new Error('课程目录页里没有找到 course_id');
  const name = String(titleMatch[1] ?? 'U校园课程').trim() || 'U校园课程';
  return { id: idMatch[1], name };
}

async function ensureContentSession(session: string, courseId: string): Promise<void> {
  const next = encodeURIComponent(`/courses/${courseId}/menus`);
  try {
    await follow(session, `${UCONTENT_BASE}/cas-auth/login/?next=${next}`, 6);
  } catch (error) {
    log('warn', `ucontent session failed: ${errorText(error)}`);
  }
}

async function loadCourse(session: string): Promise<{ id: string; name: string }> {
  if (COURSE_ID) return { id: COURSE_ID, name: 'U校园课程' };
  if (!CLASS_URL) throw { code: 'invalid_params', message: '请在模块设置里配置 class_url' };
  const auth = await readAuth(session);
  const fetcher = hostFetchFor(session);
  const response = await fetcher(CLASS_URL, {
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: CLASS_URL },
  });
  if (!response.ok) {
    throw { code: 'platform_unavailable', message: `课程目录页 HTTP ${response.status}` };
  }
  void auth;
  return courseFromCatalog(await response.text());
}

async function catalogCourses(params: any) {
  if (!CLASS_URL && !COURSE_ID) {
    throw { code: 'invalid_params', message: '请在模块设置里配置 class_url 或 course_id' };
  }
  await readAuth(String(params.session ?? ''));
  const course = await loadCourse(String(params.session ?? ''));
  return {
    courses: [
      {
        id: course.id,
        recruit_id: course.id,
        name: course.name,
        kind: 'shared',
        kind_label: '共享课',
        family: 'shared',
        progress: null,
        outline_available: true,
      },
    ],
  };
}

async function fetchText(session: string, url: string, headers: Record<string, string>, stage = 'read') {
  const response = await hostFetchFor(session, stage)(url, {
    headers: { ...BROWSER_HEADERS, ...headers },
  });
  return { response, text: await response.text() };
}

function annotatorHeaders(auth: any): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'x-annotator-auth-token': auth.token,
    authorization: auth.token,
  };
}

async function catalogUnits(params: any) {
  const session = String(params.session ?? '');
  const auth = await readAuth(session);
  const course = await loadCourse(session);
  const courseId = course.id;
  if (params.course?.id && params.course.id !== courseId) {
    throw { code: 'not_found', message: '课程不存在' };
  }
  await ensureContentSession(session, courseId);

  const treeResult = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/course/${courseId}/default/`,
    { accept: 'application/json, text/plain, */*' },
  );
  let treeJson: any;
  try {
    treeJson = JSON.parse(treeResult.text);
  } catch {
    throw {
      code: 'platform_unavailable',
      message: `课程树返回非 JSON（HTTP ${treeResult.response.status}）`,
    };
  }
  const tree = typeof treeJson.course === 'string' ? JSON.parse(treeJson.course) : treeJson.course;
  const version = String(treeJson.publish_version ?? treeJson.version ?? '');
  if (version) {
    await hostCall('cw.state', {
      session,
      namespace: 'course',
      key: courseId,
      value: { version, at: Date.now() },
    });
  }
  const units: any[] = [];

  for (const unit of tree?.units ?? []) {
    const unitId = String(unit.url ?? '');
    let leafs: Record<string, any> = {};
    try {
      const progress = await fetchText(
        session,
        `${UCONTENT_BASE}/course/api/v2/course_progress/${courseId}/${unitId}/${auth.open_id}/default/`,
        annotatorHeaders(auth),
      );
      const parsed = JSON.parse(progress.text);
      leafs = parsed?.rt?.leafs ?? {};
    } catch (error) {
      log('warn', `progress ${unitId} failed: ${errorText(error)}`);
    }

    const walk = (node: any, parentId: string) => {
      if (node?.role === 'link' && node.url) {
        let exam: any = null;
        try {
          exam = JSON.parse(String(node.summary ?? ''));
        } catch {}
        if (exam && (exam.exerciseId || exam.examId)) {
          const pass = Number(leafs?.[node.url]?.state?.pass ?? 0);
          units.push({
            id: `${node.url}::quiz-paper-link`,
            name: String(node.name ?? node.url).trim(),
            chapter_id: unitId,
            chapter_name: `${String(unit.caption ?? '').trim()} ${String(unit.name ?? '').trim()}`.trim(),
            lesson_id: parentId,
            kind: 'document',
            duration_seconds: 0,
            watched_seconds: 0,
            state: pass === 1 ? 'completed' : 'not_started',
            video_id: null,
            selectable: true,
            selectable_note: 'quiz-paper-link',
            exam: {
              exercise_id: String(exam.exerciseId ?? ''),
              exam_id: String(exam.examId ?? ''),
              question_number: String(exam.questionNumber ?? ''),
              total_score: String(exam.totalScore ?? ''),
              type: String(exam.type ?? ''),
            },
          });
        }
        return;
      }
      if (node?.role === 'group' && node.url) {
        const tab = String(node.tab_type ?? '');
        const base = String(node.base ?? '');
        if (tab !== 'text' && tab !== 'video' && tab !== 'task') {
          for (const child of node.children ?? []) walk(child, String(node.url));
          return;
        }
        if (base === 'quiz-paper-link') {
          for (const child of node.children ?? []) walk(child, String(node.url));
          return;
        }
        const kind = tab === 'video' ? 'video' : tab === 'task' ? 'document' : 'reading';
        const pass = Number(leafs?.[node.url]?.state?.pass ?? 0);
        units.push({
          id: `${node.url}::${base || tab}`,
          name: String(node.name ?? node.url).trim(),
          chapter_id: unitId,
          chapter_name: `${String(unit.caption ?? '').trim()} ${String(unit.name ?? '').trim()}`.trim(),
          lesson_id: parentId,
          kind,
          duration_seconds: 0,
          watched_seconds: 0,
          state: pass === 1 ? 'completed' : 'not_started',
          video_id: kind === 'video' ? String(node.url) : null,
          selectable: true,
          selectable_note: base,
        });
      }
      for (const child of node?.children ?? []) walk(child, String(node.url ?? parentId));
    };

    for (const child of unit.children ?? []) walk(child, unitId);
  }

  log('info', `catalog.units course=${courseId} units=${units.length}`);
  return { units };
}

// ------------------------------------------------------------------ study

function decodeContent(payload: any): any {
  const content = payload?.content;
  const k = payload?.k;
  if (typeof content !== 'string' || !content.startsWith('unipus.') || !k) return null;
  const hex = content.slice('unipus.'.length);
  const key = Buffer.from(`${CONTENT_KEY_PREFIX}${k}`, 'utf8');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const text = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()])
    .toString('utf8')
    .replace(/\u0000+$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stripHtml(value: any): string {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectQids(indexMap: any): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.qid === 'string' && node.qid) out.push(node.qid);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(indexMap);
  return out;
}

function taskAnswers(decoded: any): string[] {
  if (!decoded || typeof decoded !== 'object') return [];
  const out: string[] = [];
  for (const group of Object.values(decoded) as any[]) {
    for (const question of group?.questions ?? []) {
      const analysis = stripHtml(question?.analysis?.html);
      if (analysis) out.push(analysis);
    }
    if (out.length === 0) {
      const analysis = stripHtml(group?.analysis?.html);
      if (analysis) out.push(analysis);
    }
  }
  return out;
}

async function groupState(session: string, courseId: string, groupId: string, auth: any) {
  const { text } = await fetchText(
    session,
    `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/progress/v2/`,
    annotatorHeaders(auth),
  );
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function studyLeaf(session: string, courseId: string, unit: any, auth: any) {
  const groupId = String(unit.id ?? '').split('::')[0];
  if (!groupId) throw { code: 'invalid_params', message: '缺少 group id' };
  let version = 'default';
  try {
    const stored = await hostCall('cw.state', { session, namespace: 'course', key: courseId });
    if (stored?.value?.version) version = String(stored.value.version);
  } catch {
    // fall back to default
  }
  const response = await hostFetchFor(session, 'save_study')(
    `${UCONTENT_BASE}/api/mobile/user_group/${courseId}/${groupId}/progress/`,
    {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        'content-type': 'application/json',
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`,
      },
      body: JSON.stringify({
        status: 1,
        rid: `flowengine:studyStatus:1:${groupId}`,
        groupId,
        version: 'default',
      }),
    },
  );
  let payload: any = null;
  try {
    payload = JSON.parse(response.body);
  } catch {}
  log('info', `finish group ${groupId} v=${version} HTTP ${response.status} ${response.body.slice(0, 120)}`);
  const code = Number(payload?.code ?? 0);
  if (code === 600001 || code === 600002) {
    return {
      status: 'in_progress',
      wait_ms: 60000,
      checkpoint: { phase: 'rate_limited' },
      evidence: { rate_limited: true, message: payload?.msg ?? '' },
    };
  }
  if (code !== 0) {
    return {
      status: 'needs_human',
      reason: `进度写入失败：code ${code} ${payload?.msg ?? response.body.slice(0, 120)}`,
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await groupState(session, courseId, groupId, auth);
  const pass = Number(state?.data?.state?.state ?? 0);
  if (pass === 1) {
    return { status: 'completed', evidence: { platform_confirmed: true, pass }, checkpoint: { phase: 'done' } };
  }
  return {
    status: 'in_progress',
    wait_ms: 2000,
    checkpoint: { phase: 'submitted' },
  };
}

async function fetchUserState(session: string, courseId: string, groupId: string, auth: any) {
  const { text } = await fetchText(
    session,
    `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/`,
    annotatorHeaders(auth),
  );
  try {
    return JSON.parse(text)?.data ?? null;
  } catch {
    return null;
  }
}

function decryptSubmitContent(payload: any): any {
  const encrypted = payload?.content;
  const keySalt = payload?.k;
  if (typeof encrypted !== 'string' || !encrypted.startsWith('unipus.') || !keySalt) return null;
  const key = Buffer.from(`${CONTENT_KEY_PREFIX}${keySalt}`, 'utf8');
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  const text = Buffer.concat([
    decipher.update(Buffer.from(encrypted.slice('unipus.'.length), 'hex')),
    decipher.final(),
  ])
    .toString('utf8')
    .replace(/\u0000+$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findChoiceGroup(decoded: any): { group: any; category: string } | null {
  if (!decoded || typeof decoded !== 'object') return null;
  for (const value of Object.values(decoded) as any[]) {
    if (!value || !Array.isArray(value.questions)) continue;
    const category = String(value.category ?? '');
    if (category === 'singlechoice' || category === 'truefalse' || category === 'choice') {
      return { group: value, category };
    }
  }
  return null;
}

async function solveChoiceQuestions(
  session: string,
  group: any,
  context = '',
): Promise<Record<string, string[]> | null> {
  const questions = (group.questions ?? []).map((question: any, index: number) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
    options: (question?.options ?? []).map((option: any) => ({
      caption: String(option?.caption ?? ''),
      text: stripHtml(option?.content?.html),
    })),
  }));
  if (questions.length === 0) return null;
  const contextBlock = context.trim()
    ? `听力/视频原文：\n${context.trim()}\n`
    : '';
  const prompt = [
    '你是 U校园英语练习答题助手。',
    '根据听力/视频原文和题目选择正确答案；原文没有覆盖的信息不要编造。',
    '只输出 JSON 数组，不要解释。每项格式 {"id":"题目id","texts":["答案"]}。',
    '选择题 texts 返回正确选项的 caption（A/B/C/D），如果不确定 caption，返回选项原文。',
    contextBlock,
    JSON.stringify(questions),
  ].join('\n');
  if (context.trim()) log('info', `choice context ${context.trim().length} chars`);
  let parsed: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall('cw.ai.generate', {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}\n上次输出不是合法 JSON；这次只输出 JSON。`,
    });
    const raw = String((response as any)?.text ?? '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
      // retry
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out: Record<string, string[]> = {};
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    const texts = Array.isArray(item.texts)
      ? item.texts.map(String)
      : Array.isArray(item.answers)
        ? item.answers.map(String)
        : [];
    if (id) out[id] = texts;
  }
  return out;
}

async function askAiForItems(session: string, prompt: string): Promise<any[] | null> {
  let parsed: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall('cw.ai.generate', {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}\n上次输出不是合法 JSON；这次只输出 JSON。`,
    });
    const raw = String((response as any)?.text ?? '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
      // retry
    }
  }
  return Array.isArray(parsed) ? parsed : null;
}

function answerMapFromItems(items: any[] | null): Record<string, string[]> | null {
  if (!items) return null;
  const out: Record<string, string[]> = {};
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    const texts = Array.isArray(item.texts)
      ? item.texts.map(String)
      : Array.isArray(item.answers)
        ? item.answers.map(String)
        : [];
    if (id) out[id] = texts;
  }
  return out;
}

async function solveSequenceQuestions(
  session: string,
  group: any,
  context = '',
): Promise<Record<string, string[]> | null> {
  const questions = (group.questions ?? []).map((question: any, index: number) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
  }));
  const options = (group.options ?? []).map((option: any) => ({
    caption: String(option?.caption ?? ''),
    text: stripHtml(option?.content?.html),
  }));
  if (questions.length === 0 || options.length === 0) return null;
  const prompt = [
    '你是 U校园英语练习答题助手。',
    '这是排序/匹配题。题目中的图片或空格按顺序对应听力原文中的人物或段落。',
    '请根据原文，把每个题目匹配到正确选项。',
    '只输出 JSON 数组，不要解释。每项格式 {"id":"题目id","texts":["A"]}，texts 只放一个选项 caption。',
    context.trim() ? `听力/视频原文：\n${context.trim()}` : '',
    `选项：${JSON.stringify(options)}`,
    JSON.stringify(questions),
  ].join('\n');
  return answerMapFromItems(await askAiForItems(session, prompt));
}

async function solveMultiChoiceQuestions(
  session: string,
  group: any,
  context = '',
): Promise<Record<string, string[]> | null> {
  const questions = (group.questions ?? []).map((question: any, index: number) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
    options: (question?.options ?? []).map((option: any) => ({
      caption: String(option?.caption ?? ''),
      text: stripHtml(option?.content?.html),
    })),
  }));
  if (questions.length === 0) return null;
  const prompt = [
    '你是 U校园英语练习答题助手。',
    '这是多选题，每道题可能有多个正确选项。',
    '根据听力/视频原文和题目，选出所有正确选项。',
    '只输出 JSON 数组，不要解释。每项格式 {"id":"题目id","texts":["A","C"]}。',
    context.trim() ? `听力/视频原文：\n${context.trim()}` : '',
    JSON.stringify(questions),
  ].join('\n');
  return answerMapFromItems(await askAiForItems(session, prompt));
}

function parseVtt(text: string): string {
  const out: string[] = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^\d+$/.test(line) || line.includes('-->')) continue;
    const clean = stripHtml(line.replace(/<[^>]+>/g, ' '));
    if (!clean) continue;
    if (out[out.length - 1] === clean) continue;
    out.push(clean);
  }
  return out.join(' ');
}

const asrCache = new Map<string, string>();

async function transcribeAudio(session: string, audioUrl: string): Promise<string> {
  if (!ASR_ENABLED) return '';
  const url = audioUrl.replace(/#.*$/, '');
  if (asrCache.has(url)) return asrCache.get(url) ?? '';
  let binary: any = null;
  try {
    binary = await hostCall('cw.net.fetch', {
      session,
      method: 'GET',
      url,
      headers: { ...BROWSER_HEADERS, accept: '*/*' },
      stage: 'read',
      binary: true,
    });
  } catch (error) {
    log('warn', `asr download failed: ${errorText(error)}`);
    return '';
  }
  if (!binary?.body) return '';
  const dir = mkdtempSync(join(tmpdir(), 'courseflow-asr-'));
  const audioPath = join(dir, 'audio.mp3');
  const scriptPath = fileURLToPath(new URL('./scripts/transcribe_audio.py', import.meta.url));
  try {
    writeFileSync(audioPath, Buffer.from(String(binary.body), 'base64'));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(ASR_PYTHON, [scriptPath, audioPath, ASR_MODEL], {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          HF_ENDPOINT: process.env.HF_ENDPOINT || process.env.CF_ASR_HF_ENDPOINT || 'https://hf-mirror.com',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`ASR timeout ${ASR_TIMEOUT_MS}ms`));
      }, ASR_TIMEOUT_MS);
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`ASR exit ${code}: ${stderr.slice(-300)}`));
      });
    });
    const parsed = JSON.parse(output.trim());
    const text = String(parsed?.text ?? '').trim();
    if (text) {
      asrCache.set(url, text);
      log('info', `asr ${url.slice(-48)} -> ${text.length} chars`);
    }
    return text;
  } catch (error) {
    log('warn', `asr failed: ${errorText(error)}`);
    return '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function collectStudyContext(session: string, decoded: any): Promise<string> {
  const parts: string[] = [];
  const seenVtt = new Set<string>();
  const seenAsr = new Set<string>();
  if (!decoded || typeof decoded !== 'object') return '';
  for (const group of Object.values(decoded) as any[]) {
    for (const content of group?.content ?? []) {
      const script = content?.audio?.script;
      const scriptHtml = typeof script === 'string' ? script : script?.html;
      if (scriptHtml) {
        const text = stripHtml(scriptHtml);
        if (text) parts.push(text);
      }
      const scoopHtml = content?.scoop?.html;
      if (scoopHtml) {
        const text = stripHtml(scoopHtml);
        if (text) parts.push(text);
      }
      const videoFile = content?.video?.file;
      if (
        typeof videoFile === 'string' &&
        /\.vtt(?:\?|#|$)/i.test(videoFile) &&
        !seenVtt.has(videoFile)
      ) {
        seenVtt.add(videoFile);
        try {
          const { text } = await fetchText(session, videoFile, { accept: '*/*' }, 'read');
          const parsed = parseVtt(text);
          if (parsed) parts.push(parsed);
        } catch (error) {
          log('warn', `vtt ${videoFile} failed: ${errorText(error)}`);
        }
      }
      const audioUrl = content?.audio?.audio?.url;
      if (
        !scriptHtml &&
        !videoFile &&
        typeof audioUrl === 'string' &&
        audioUrl &&
        !seenAsr.has(audioUrl)
      ) {
        seenAsr.add(audioUrl);
        const text = await transcribeAudio(session, audioUrl);
        if (text) parts.push(text);
      }
    }
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text = part.replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  return unique.join('\n\n').slice(0, 16000);
}

function findQuestionGroup(decoded: any): any | null {
  if (!decoded || typeof decoded !== 'object') return null;
  const groups = (Object.values(decoded) as any[]).filter(
    (value) => value && Array.isArray(value.questions),
  );
  if (groups.length === 0) return null;
  if (groups.length === 1) return groups[0];
  return {
    ...groups[0],
    questions: groups.flatMap((group) => group.questions ?? []),
  };
}

function pageMeta(indexMap: any, pageId: string): { qid?: string; rules: any } {
  let found: any = null;
  const walk = (node: any) => {
    if (!node || typeof node !== 'object' || found) return;
    if (typeof node.qid === 'string') {
      found = { qid: node.qid, rules: node.rules ?? [] };
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(indexMap?.[pageId] ?? {});
  return found ?? { rules: [] };
}

async function solveTextQuestions(
  session: string,
  group: any,
  context = '',
): Promise<Record<string, string[]> | null> {
  const questions = (group.questions ?? []).map((question: any, index: number) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
  }));
  if (questions.length === 0) return null;
  const prompt = [
    '你是 U校园英语练习答题助手。',
    '只输出 JSON 数组，不要解释。每项格式 {"id":"题目id","texts":["答案"]}。',
    '简答题/填空题给出简短、直接、符合题意的英文答案。',
    '原文里的 ____1____、____2____ 是待填空位，题目 id 对应空位编号，按编号填写。',
    context.trim() ? `听力/视频原文：\n${context.trim()}` : '',
    JSON.stringify(questions),
  ].join('\n');
  let parsed: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall('cw.ai.generate', {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}\n上次输出不是合法 JSON；这次只输出 JSON。`,
    });
    const raw = String((response as any)?.text ?? '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
      // retry
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out: Record<string, string[]> = {};
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    const texts = Array.isArray(item.texts)
      ? item.texts.map(String)
      : Array.isArray(item.answers)
        ? item.answers.map(String)
        : [];
    if (id) out[id] = texts;
  }
  return out;
}

function scriptAnswers(decoded: any): string[] {
  const out: string[] = [];
  if (!decoded || typeof decoded !== 'object') return out;
  for (const group of Object.values(decoded) as any[]) {
    for (const content of group?.content ?? []) {
      const script = content?.audio?.script;
      const html = typeof script === 'string' ? script : script?.html;
      if (!html) continue;
      const matches = String(html).matchAll(/<span[^>]*text-decoration:\s*underline[^>]*>([\s\S]*?)<\/span>/g);
      for (const match of matches) {
        const text = stripHtml(match[1]);
        if (text) out.push(text);
      }
    }
  }
  return out;
}

function browserStudyTask(mode: string, values: string[]) {
  return (async () => {
    const doc: any = document;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (node: any) => Boolean(node && node.offsetParent !== null);
    const clickText = (text: string) => {
      const node = (Array.from(doc.querySelectorAll('*')) as any[]).find(
        (n: any) => n.children.length === 0 && (n.textContent || '').trim() === text && visible(n),
      );
      if (!node) return false;
      node.click();
      return true;
    };
    const dismissOverlays = async () => {
      doc.querySelectorAll('.bfg-mask, .layui-layer, [class*="tooltip"]').forEach((el: any) => el.remove());
      clickText('我知道了');
      await sleep(200);
      clickText('确定');
      await sleep(400);
    };
    const waitFor = async (selector: string, timeoutMs = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const nodes = Array.from(doc.querySelectorAll(selector)) as any[];
        if (nodes.length) return nodes;
        clickText('我知道了');
        clickText('确定');
        await sleep(300);
      }
      return [] as any[];
    };
    const submitAndConfirm = async () => {
      await dismissOverlays();
      const barButtons = Array.from(doc.querySelectorAll('button[class*="submit-bar-pc--btn"]')) as any[];
      const submit =
        barButtons[barButtons.length - 1] ??
        (Array.from(doc.querySelectorAll('button')) as any[]).find((b: any) => (b.textContent || '').trim() === '提交');
      submit?.click();
      const started = Date.now();
      let confirmed = false;
      while (Date.now() - started < 8000) {
        await sleep(400);
        if (clickText('确认')) {
          confirmed = true;
          break;
        }
      }
      await sleep(1000);
      const tail = String(doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return { submitted: Boolean(submit), confirmed, message: confirmed ? '' : tail.slice(-180) };
    };

    await dismissOverlays();
    if (mode === 'choice') {
      const radios = (await waitFor('input[type="radio"]')) as any[];
      const groups: any[][] = [];
      const byName = new Map<string, any[]>();
      for (const radio of radios) {
        const name = String(radio.name || '');
        if (!name) continue;
        if (!byName.has(name)) {
          const group: any[] = [];
          byName.set(name, group);
          groups.push(group);
        }
        byName.get(name)?.push(radio);
      }
      const picked: string[] = [];
      values.slice(0, groups.length).forEach((caption: string, index: number) => {
        const group = groups[index];
        const target = group.find((radio: any) => String(radio.value).toUpperCase() === caption.toUpperCase());
        if (!target) return;
        const label = target.closest('label') ?? target;
        label.click();
        picked.push(String(target.value));
      });
      if (groups.length === 0 || picked.length === 0) {
        return { mode, groups: groups.length, picked, submitted: false, confirmed: false, error: 'no_choices' };
      }
      await sleep(800);
      const result = await submitAndConfirm();
      return { mode, groups: groups.length, picked, ...result };
    }

    const inputs = (await waitFor('input[type="text"]')) as any[];
    if (inputs.length === 0) {
      return { mode, inputs: 0, filled: 0, submitted: false, confirmed: false, error: 'no_inputs' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    inputs.slice(0, values.length).forEach((input: any, index: number) => {
      if (descriptor?.set) descriptor.set.call(input, values[index]);
      else input.value = values[index];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    await sleep(800);
    const result = await submitAndConfirm();
    return { mode, inputs: inputs.length, filled: inputs.filter((i: any) => i.value).length, ...result };
  })();
}

function isSinglePageTask(questionsList: any[]): boolean {
  const pages = new Set(
    (questionsList ?? []).map((item: any) => String(item?.path?.[0]?.[1] ?? '')),
  );
  return pages.size <= 1;
}

function coursewareUrl(courseId: string, groupId: string, questionsList: any[]) {
  const parentPath = questionsList?.[0]?.path?.[1] ?? [];
  const coursewarePath = [...parentPath, groupId];
  return `${UCONTENT_BASE}/_pc_default/pc.html?cid=${CLASS_ID}&appid=5&schId=${SCHOOL_ID}#/${courseId}/courseware/${coursewarePath.join('/')}/p_1`;
}

async function browserStudy(
  session: string,
  courseId: string,
  groupId: string,
  url: string,
  mode: 'fill' | 'choice',
  values: string[],
  auth: any,
  minScorePct: number,
) {
  let opened: any = null;
  try {
    opened = await hostCall('cw.browser.open', { session, url, purpose: 'study' });
  } catch (error) {
    return { status: 'needs_human', reason: `官方浏览器不可用：${errorText(error)}` };
  }
  const page = opened?.page;
  if (!page) return { status: 'needs_human', reason: '官方浏览器没有返回页面句柄' };
  let result: any = null;
  try {
    const expression = `(${browserStudyTask.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(values)})`;
    result = await hostCall('cw.browser.evaluate', {
      session,
      page,
      stage: 'save_study',
      expression,
    });
    log('info', `browser ${mode} ${groupId}: ${JSON.stringify(result).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 4000));
  } catch (error) {
    result = { error: errorText(error) };
    log('warn', `browser ${mode} ${groupId} failed: ${errorText(error)}`);
  } finally {
    await hostCall('cw.browser.close', { session, page }).catch(() => {});
  }
  const state = await groupState(session, courseId, groupId, auth);
  const pass = Number(state?.data?.state?.state ?? 0);
  const score = state?.data?.state?.score_avg ?? null;
  if (pass === 1 && (minScorePct === 0 || Number(score ?? 0) >= minScorePct * 100)) {
    return {
      status: 'completed',
      evidence: { platform_confirmed: true, score, browser: true, browser_result: result },
      checkpoint: { phase: 'done' },
    };
  }
  const detail = String(result?.message ?? '').trim();
  return {
    status: 'needs_human',
    reason: `浏览器提交后平台未确认（state ${pass}, score ${score ?? '?'}）${detail ? `：${detail}` : ''}`,
    evidence: { browser_result: result, state: pass, score },
  };
}

async function studyFillblankBrowser(
  session: string,
  courseId: string,
  groupId: string,
  decoded: any,
  questionGroup: any,
  questionsList: any[],
  auth: any,
  minScorePct: number,
) {
  let answers = scriptAnswers(decoded);
  if (answers.length === 0) {
    const context = await collectStudyContext(session, decoded);
    const solved = await solveTextQuestions(session, questionGroup, context);
    if (solved) {
      answers = (questionGroup.questions ?? []).map(
        (_: any, index: number) => solved[String(index)]?.[0] ?? '',
      );
    }
  }
  if (answers.length === 0) {
    return { status: 'needs_human', reason: '填空题没有答案来源' };
  }
  const result = await browserStudy(
    session,
    courseId,
    groupId,
    coursewareUrl(courseId, groupId, questionsList),
    'fill',
    answers,
    auth,
    minScorePct,
  );
  return {
    ...result,
    evidence: { ...(result as any).evidence, fill_answers: answers },
  };
}

function matchChoiceCaption(options: any[], texts: string[]): string {
  const normalized = texts.map((value) => String(value).trim()).filter(Boolean);
  for (const value of normalized) {
    const exactCaption = options.find(
      (option: any) => String(option?.caption ?? '').trim().toLowerCase() === value.toLowerCase(),
    );
    if (exactCaption) return String(exactCaption.caption);
  }
  for (const value of normalized) {
    const exactText = options.find(
      (option: any) => stripHtml(option?.content?.html).toLowerCase() === value.toLowerCase(),
    );
    if (exactText) return String(exactText.caption);
  }
  for (const value of normalized) {
    if (value.length < 4) continue;
    const partial = options.find((option: any) => {
      const text = stripHtml(option?.content?.html).toLowerCase();
      return text.includes(value.toLowerCase()) || value.toLowerCase().includes(text);
    });
    if (partial) return String(partial.caption);
  }
  return String(options[0]?.caption ?? 'A');
}

function choiceCaptions(group: any, solved: Record<string, string[]>): string[] {
  const questions = group?.questions ?? [];
  return questions.map((question: any, index: number) => {
    const options = question.options ?? [];
    return matchChoiceCaption(options, solved[String(index)] ?? []);
  });
}

async function studyChoiceBrowser(
  session: string,
  courseId: string,
  groupId: string,
  decoded: any,
  questionGroup: any,
  questionsList: any[],
  auth: any,
  minScorePct: number,
) {
  const context = await collectStudyContext(session, decoded);
  const solved = await solveChoiceQuestions(session, questionGroup, context);
  if (!solved) return { status: 'needs_human', reason: '模型没有返回可用的选择题答案' };
  const captions = choiceCaptions(questionGroup, solved);
  const result = await browserStudy(
    session,
    courseId,
    groupId,
    coursewareUrl(courseId, groupId, questionsList),
    'choice',
    captions,
    auth,
    minScorePct,
  );
  return {
    ...result,
    evidence: { ...(result as any).evidence, choice_answers: captions },
  };
}

async function studyObjectiveApi(
  session: string,
  courseId: string,
  groupId: string,
  decoded: any,
  questionGroup: any,
  questionsList: any[],
  indexMap: any,
  auth: any,
  minScorePct: number,
  precomputedValues?: any[],
) {
  const category = String(questionGroup.category ?? '').toLowerCase();
  const isFill = /fillblank/.test(category);
  const isSequence = category === 'sequence';
  const isMulti = category === 'multichoice';
  const choice = !isFill && !isSequence && !isMulti ? { group: questionGroup, category } : null;
  const questions = questionGroup.questions ?? [];
  let values: any[] = precomputedValues ?? [];
  if (isFill) {
    if (values.length === 0) values = scriptAnswers(decoded);
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveTextQuestions(session, questionGroup, context);
      if (!solved) return { status: 'needs_human', reason: 'fillblankScoop 没有答案来源' };
      values = questions.map((_: any, index: number) => solved[String(index)]?.[0] ?? '');
    }
  } else if (isSequence) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveSequenceQuestions(session, questionGroup, context);
      if (!solved) return { status: 'needs_human', reason: '模型没有返回可用的排序题答案' };
      values = questions.map((_: any, index: number) => solved[String(index)]?.[0] ?? '');
    }
  } else if (isMulti) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveMultiChoiceQuestions(session, questionGroup, context);
      if (!solved) return { status: 'needs_human', reason: '模型没有返回可用的多选题答案' };
      values = questions.map((_: any, index: number) => solved[String(index)] ?? []);
    }
  } else if (choice) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveChoiceQuestions(session, choice.group, context);
      if (!solved) return { status: 'needs_human', reason: '模型没有返回可用的选择题答案' };
      values = choiceCaptions(choice.group, solved);
    }
  } else {
    return { status: 'needs_human', reason: `未支持的客观题类型 ${category || 'unknown'}` };
  }

  if (values.length === 0) return { status: 'needs_human', reason: '没有构造出答案' };
  const userState = await fetchUserState(session, courseId, groupId, auth);
  const version = String(
    userState?.state?.version ?? userState?.version ?? Math.floor(Date.now() / 1000),
  );
  const firstQid = collectQids(indexMap)[0];
  if (!firstQid) return { status: 'needs_human', reason: '题组没有返回 qid' };

  const multiPage = !isSinglePageTask(questionsList);
  const pages: Record<string, any> = {};
  const answerList: Record<string, any> = {};
  const answers: Record<string, any> = {};
  for (let index = 0; index < questions.length; index += 1) {
    const path = questionsList[index]?.path?.[0] ?? [];
    const pageId = String(path[1] ?? 'p_1');
    const meta = pageMeta(indexMap, pageId);
    const qid = meta.qid ?? firstQid;
    const defaultRule = isFill ? 'in' : isSequence ? 'eq_ig_case' : isMulti ? 'contain' : 'eq';
    const rule = String(
      (Array.isArray(meta.rules) ? meta.rules[index] ?? meta.rules[0] : meta.rules) ??
        defaultRule,
    );
    const rawValue = values[index];
    const value = isMulti
      ? (Array.isArray(rawValue) ? rawValue.map(String) : rawValue ? [String(rawValue)] : [])
      : String(rawValue ?? '');
    const slicedPage = multiPage && !isSequence && !isMulti;
    const answerIndex = slicedPage ? 0 : index;
    const offset = slicedPage ? index : 0;
    answerList[String(index)] = {
      student_answer: value,
      isDone: true,
      version: 'v2',
      rule,
    };
    answers[String(index)] = {
      student_answer: value,
      isDone: true,
      version: 'v2',
      rule,
      user_answer: {
        qid,
        rule,
        answer: { index: answerIndex, answer: value, version: 'v2' },
        content: '',
        id: `${qid}-${answerIndex}`,
        offset,
      },
    };
    const existingComponent = userState?.state?.[pageId]
      ? Object.keys(userState.state[pageId])[0]
      : '';
    const component = existingComponent || (isSequence ? 'c_1_0' : 'c_1_1');
    if (isMulti) {
      pages[pageId] ??= { [component]: { student_answers: [] } };
      pages[pageId][component].student_answers[index] = value;
    } else if (isSequence) {
      pages[pageId] ??= { [component]: { student_answers: {} } };
      pages[pageId][component].student_answers[String(index)] = value;
    } else {
      pages[pageId] ??= { [component]: { student_answers: multiPage ? [] : {} } };
      if (multiPage) pages[pageId][component].student_answers[0] = value;
      else pages[pageId][component].student_answers[String(index)] = value;
    }
  }

  const stateObj = {
    version,
    ...pages,
    __EXTEND_DATA__: { __SUMMARY__: { answerList } },
  };
  const payload = {
    enable_mistake: false,
    version: 'default',
    record_version: version,
    state: JSON.stringify(stateObj),
    specific_scores: questions.map(() => null),
    answers,
  };
  const submit = await hostFetchFor(session, 'save_study')(
    `${UCONTENT_BASE}/course/api/v3/submit/${courseId}/${groupId}/`,
    {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        'content-type': 'application/json',
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`,
      },
      body: JSON.stringify(payload),
    },
  );
  let submitJson: any = null;
  try {
    submitJson = JSON.parse(submit.body);
  } catch {}
  log('info', `submit ${groupId} HTTP ${submit.status} code ${submitJson?.code ?? '?'}`);
  if (submitJson?.code !== 0) {
    return {
      status: 'needs_human',
      reason: `题组提交失败：code ${submitJson?.code ?? '?'} ${submitJson?.msg ?? submit.body.slice(0, 160)}`,
    };
  }
  const info = submitJson?.data?.submit_info;
  const submitState = Number(info?.state?.state ?? 0);
  const scorePct = Number(info?.state?.real_score_pct ?? info?.state?.score_pct ?? 0);
  const score = info?.state?.score ?? null;
  if (submitState === 1 && (minScorePct === 0 || scorePct >= minScorePct)) {
    return {
      status: 'completed',
      evidence: { platform_confirmed: true, score, score_pct: scorePct, min_score_pct: minScorePct, api: true },
      checkpoint: { phase: 'done' },
    };
  }
  return {
    status: 'needs_human',
    reason: `题组已提交但未达到通过条件（score_pct ${scorePct}, min ${minScorePct}）`,
    evidence: { score, score_pct: scorePct, min_score_pct: minScorePct },
  };
}

function isShortAnswerTask(category: string, decoded: any): boolean {
  if (category === 'shortanswerscoop') return true;
  const keys = Object.keys(decoded ?? {});
  return keys.some((key) => key === 'shortanswer:shortanswer' || key === 'questions:shortanswer');
}

function isOralTask(decoded: any): boolean {
  const keys = Object.keys(decoded ?? {});
  return keys.some(
    (key) =>
      /^(roleplay|presentation):/.test(key) ||
      /sentencesforrecord|individualpresentation-course/i.test(key),
  );
}

async function studyShortAnswerApi(
  session: string,
  courseId: string,
  groupId: string,
  decoded: any,
  questionGroup: any,
  questionsList: any[],
  indexMap: any,
  auth: any,
  minScorePct: number,
) {
  const category = String(questionGroup.category ?? '').toLowerCase();
  const questions = questionGroup.questions ?? [];
  if (questions.length === 0) return { status: 'needs_human', reason: '短答题没有题目' };
  const context = await collectStudyContext(session, decoded);
  const solved = await solveTextQuestions(session, questionGroup, context);
  if (!solved) return { status: 'needs_human', reason: '模型没有返回可用的短答题答案' };
  const values = questions.map((_: any, index: number) => solved[String(index)]?.[0] ?? '');
  if (values.every((value: string) => !value.trim())) {
    return { status: 'needs_human', reason: '短答题没有生成有效答案' };
  }

  const userState = await fetchUserState(session, courseId, groupId, auth);
  const version = String(
    userState?.state?.version ?? userState?.version ?? Math.floor(Date.now() / 1000),
  );
  const firstQid = collectQids(indexMap)[0];
  if (!firstQid) return { status: 'needs_human', reason: '题组没有返回 qid' };
  const pageId = String(questionsList?.[0]?.path?.[0]?.[1] ?? 'p_1');
  const meta = pageMeta(indexMap, pageId);
  const qid = meta.qid ?? firstQid;
  const keys = Object.keys(decoded ?? {});
  const component =
    category === 'shortanswerscoop' || keys.some((key) => /^shortanswer:/.test(key))
      ? 'c_1_1'
      : 'c_1_0';

  const studentAnswers: Record<string, string> = {};
  const answerList: Record<string, any> = {};
  const answers: Record<string, any> = {};
  for (let index = 0; index < questions.length; index += 1) {
    const value = values[index] ?? '';
    studentAnswers[String(index)] = value;
    answerList[String(index)] = {
      student_answer: value,
      isDone: true,
      version: 'v2',
      rule: 'subjective',
    };
    answers[String(index)] = {
      student_answer: value,
      isDone: true,
      version: 'v2',
      rule: 'subjective',
    };
  }
  const stateObj = {
    version,
    [pageId]: { [component]: { student_answers: studentAnswers } },
    __EXTEND_DATA__: { __SUMMARY__: { answerList } },
  };
  const payload = {
    enable_mistake: false,
    version: 'default',
    record_version: version,
    state: JSON.stringify(stateObj),
    specific_scores: questions.map(() => null),
    answers,
  };
  const submit = await hostFetchFor(session, 'save_study')(
    `${UCONTENT_BASE}/course/api/v3/submit/${courseId}/${groupId}/`,
    {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        'content-type': 'application/json',
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`,
      },
      body: JSON.stringify(payload),
    },
  );
  let submitJson: any = null;
  try {
    submitJson = JSON.parse(submit.body);
  } catch {}
  log('info', `submit shortanswer ${groupId} HTTP ${submit.status} code ${submitJson?.code ?? '?'}`);
  if (submitJson?.code !== 0) {
    return {
      status: 'needs_human',
      reason: `短答题提交失败：code ${submitJson?.code ?? '?'} ${submitJson?.msg ?? submit.body.slice(0, 160)}`,
    };
  }
  const info = submitJson?.data?.submit_info;
  const submitState = Number(info?.state?.state ?? 0);
  const scorePct = Number(info?.state?.real_score_pct ?? info?.state?.score_pct ?? 0);
  if (submitState === 1 && (minScorePct === 0 || scorePct >= minScorePct)) {
    return {
      status: 'completed',
      evidence: { platform_confirmed: true, subjective: true, score_pct: scorePct },
      checkpoint: { phase: 'done' },
    };
  }
  return {
    status: 'needs_human',
    reason: `短答题已提交但平台未确认（state ${submitState}, score_pct ${scorePct}）`,
    evidence: { state: submitState, score_pct: scorePct },
  };
}

async function studyTask(session: string, courseId: string, unit: any, auth: any) {
  const groupId = String(unit.id ?? '').split('::')[0];
  if (String(unit.selectable_note ?? '') === 'quiz-paper-link' || unit.exam) {
    return {
      status: 'needs_human',
      reason: '单元测试是独立的 uexercise 试卷应用，当前只接入目录，不自动答题/交卷',
      evidence: { exam: unit.exam ?? null },
    };
  }
  let minScorePct = 0;
  let progressData: any = null;
  try {
    const progress = await fetchText(
      session,
      `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/progress/v2/`,
      annotatorHeaders(auth),
    );
    progressData = JSON.parse(progress.text)?.data ?? null;
    minScorePct = Number(progressData?.flowStrategy?.task_mini_score_pct ?? 0);
  } catch {
    minScorePct = 0;
  }
  const now = Math.floor(Date.now() / 1000);
  const startTime = Number(progressData?.flowStrategy?.startTime ?? 0);
  const endTime = Number(progressData?.flowStrategy?.endTime ?? 0);
  if (startTime > 0 && now < startTime) {
    return {
      status: 'blocked',
      reason: '学习开始时间未到，平台不允许提交',
      wait_ms: Math.min((startTime - now) * 1000, 3600000),
      evidence: { start_time: startTime, now },
    };
  }
  if (endTime > 0 && now > endTime) {
    return {
      status: 'blocked',
      reason: '学习截止时间已过，平台不允许提交',
      evidence: { end_time: endTime, now },
    };
  }
  if (minScorePct > 0 && SETTINGS.enable_task_submit !== true && !BROWSER_STUDY) {
    return {
      status: 'needs_human',
      reason: `题组有计分要求（min_score_pct=${minScorePct}），自动提交默认关闭`,
    };
  }
  const summary = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/pc/summary/${courseId}/${groupId}/default/`,
    annotatorHeaders(auth),
  );
  let summaryJson: any = null;
  try {
    summaryJson = JSON.parse(summary.text);
  } catch {}
  const indexMap = summaryJson?.summary?.indexMap ?? {};
  const questionsList = summaryJson?.summary?.questionsList ?? [];
  const qids = collectQids(indexMap);
  if (qids.length === 0) {
    return { status: 'needs_human', reason: '题组没有返回 qid' };
  }

  const content = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/v3/content/${courseId}/${groupId}/default/`,
    { accept: 'application/json, text/plain, */*' },
  );
  let contentJson: any = null;
  try {
    contentJson = JSON.parse(content.text);
  } catch {}
  const decoded = decodeContent(contentJson);
  if (isOralTask(decoded)) {
    return { status: 'needs_human', reason: '口语/录音题，需要人工完成' };
  }
  const questionGroup = findQuestionGroup(decoded);
  if (!questionGroup) {
    return { status: 'needs_human', reason: '题组内容里没有题目' };
  }
  const category = String(questionGroup.category ?? '').toLowerCase();
  const isFill = /fillblank/.test(category);
  const isChoice = category === 'singlechoice' || category === 'truefalse' || category === 'true_false' || category === 'choice';
  if (isFill) {
    if (!isSinglePageTask(questionsList)) {
      if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
        return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
      }
      return { status: 'needs_human', reason: '多页填空题会计分，自动提交默认关闭' };
    }
    if (BROWSER_STUDY) {
      const browserResult: any = await studyFillblankBrowser(
        session, courseId, groupId, decoded, questionGroup, questionsList, auth, minScorePct,
      );
      if (browserResult.status === 'completed') return browserResult;
      const rawState = browserResult?.evidence?.state;
      if (!(rawState === undefined || rawState === null || Number(rawState) === 0)) return browserResult;
      if (!isSinglePageTask(questionsList)) {
        return { ...browserResult, reason: `${browserResult.reason}；多页题组暂不支持 API 兜底` };
      }
      log('warn', `browser did not submit ${groupId}, falling back to API`);
      const apiResult = await studyObjectiveApi(
        session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct,
        browserResult?.evidence?.fill_answers,
      );
      if (apiResult.status === 'completed') {
        return { ...apiResult, evidence: { ...(apiResult as any).evidence, fallback: 'browser_to_api' } };
      }
      return apiResult;
    }
    if (SETTINGS.enable_task_submit !== true) {
      return { status: 'needs_human', reason: '填空题会计分，API 自动提交默认关闭' };
    }
    return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
  }
  if (isChoice) {
    if (!isSinglePageTask(questionsList)) {
      if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
        return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
      }
      return { status: 'needs_human', reason: '多页选择题会计分，自动提交默认关闭' };
    }
    if (BROWSER_STUDY) {
      const browserResult: any = await studyChoiceBrowser(
        session, courseId, groupId, decoded, questionGroup, questionsList, auth, minScorePct,
      );
      if (browserResult.status === 'completed') return browserResult;
      const rawState = browserResult?.evidence?.state;
      if (!(rawState === undefined || rawState === null || Number(rawState) === 0)) return browserResult;
      if (!isSinglePageTask(questionsList)) {
        return { ...browserResult, reason: `${browserResult.reason}；多页题组暂不支持 API 兜底` };
      }
      log('warn', `browser did not submit ${groupId}, falling back to API`);
      const apiResult = await studyObjectiveApi(
        session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct,
        browserResult?.evidence?.choice_answers,
      );
      if (apiResult.status === 'completed') {
        return { ...apiResult, evidence: { ...(apiResult as any).evidence, fallback: 'browser_to_api' } };
      }
      return apiResult;
    }
    if (SETTINGS.enable_task_submit !== true) {
      return { status: 'needs_human', reason: '选择题会计分，API 自动提交默认关闭' };
    }
    return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
  }
  const isSequence = category === 'sequence';
  const isMulti = category === 'multichoice';
  if (isSequence || isMulti) {
    if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
      return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
    }
    return { status: 'needs_human', reason: '排序/多选题会计分，自动提交默认关闭' };
  }

  if (isShortAnswerTask(category, decoded)) {
    return studyShortAnswerApi(
      session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct,
    );
  }
  if (isOralTask(decoded)) {
    return {
      status: 'needs_human',
      reason: '口语/录音题，需要人工完成',
    };
  }
  return {
    status: 'needs_human',
    reason: `未支持的任务类型（${category || Object.keys(decoded ?? {}).join(',') || 'unknown'}）`,
  };
}
async function studyStep(params: any) {
  const session = String(params.session ?? '');
  const unit = params.unit ?? {};
  const rawId = String(unit.id ?? '');
  if (!rawId) throw { code: 'invalid_params', message: '缺少单元 id' };
  const auth = await readAuth(session);
  const course = await loadCourse(session);
  if (String(unit.kind) === 'document') {
    return studyTask(session, course.id, unit, auth);
  }
  return studyLeaf(session, course.id, unit, auth);
}

// ------------------------------------------------------------------ rpc

async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    case 'platform.describe':
      return describe(params);
    case 'auth.begin':
      return authBegin(params);
    case 'auth.submit':
      return authSubmit(params);
    case 'auth.poll':
      return authPoll(params);
    case 'auth.complete':
      return authComplete(params);
    case 'auth.verify':
      return authVerify(params);
    case 'auth.keepalive':
      return authKeepalive(params);
    case 'catalog.courses':
      return catalogCourses(params);
    case 'catalog.units':
      return catalogUnits(params);
    case 'study.step':
      return studyStep(params);
    default:
      throw { code: 'unsupported_operation', message: `U校园普通版未实现 ${method}` };
  }
}

async function handleRequest(request: any) {
  try {
    const result = await dispatch(request.method, request.params ?? {});
    write({ jsonrpc: '2.0', id: request.id, result: result ?? {} });
  } catch (error: any) {
    write({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: error?.code ?? 'module_error',
        message: error?.message ?? String(error),
      },
    });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message: any;
  try {
    message = JSON.parse(text);
  } catch {
    log('warn', 'ignored non-JSON input');
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
    return;
  }
  if (typeof message.method === 'string' && message.id !== undefined) {
    void handleRequest(message);
  }
});

lines.on('close', () => process.exit(0));
