// src/module.ts
import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
var MANIFEST = JSON.parse(
  readFileSync(new URL("./courseflow.module.json", import.meta.url), "utf8")
);
var SETTINGS = (() => {
  try {
    const parsed = JSON.parse(process.env.CF_MODULE_SETTINGS || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
})();
var SSO_BASE = "https://sso.unipus.cn";
var UNIPUS_BASE = typeof SETTINGS.base_url === "string" && SETTINGS.base_url.trim() ? SETTINGS.base_url.trim().replace(/\/$/, "") : "https://u.unipus.cn";
var UCONTENT_BASE = typeof SETTINGS.content_base_url === "string" && SETTINGS.content_base_url.trim() ? SETTINGS.content_base_url.trim().replace(/\/$/, "") : "https://ucontent.unipus.cn";
var CLASS_URL = typeof SETTINGS.class_url === "string" ? SETTINGS.class_url.trim() : "";
var COURSE_ID = typeof SETTINGS.course_id === "string" ? SETTINGS.course_id.trim() : "";
var SCHOOL_ID = (() => {
  if (SETTINGS.school_id !== void 0 && SETTINGS.school_id !== null) {
    return String(SETTINGS.school_id);
  }
  const match = CLASS_URL.match(/[?&]school_id=(\d+)/);
  return match ? match[1] : "";
})();
var CLASS_ID = (() => {
  const match = CLASS_URL.match(/[?&]classId=(\d+)/);
  return match ? match[1] : "";
})();
var DB_COURSE_ID = (() => {
  const match = CLASS_URL.match(/[?&]courseId=(\d+)/);
  return match ? match[1] : "";
})();
var LOGIN_AES_KEY = Buffer.from("8AD70B641C024C7ADA2ECD082EC0334F", "hex");
var LOGIN_AES_IV = Buffer.from("0102030405060708090A0B0C0D0E0F10", "hex");
var CONTENT_KEY_PREFIX = "1a2b3c4d";
var BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var BROWSER_HEADERS = {
  "user-agent": BROWSER_UA,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"'
};
var write = (message) => process.stdout.write(`${JSON.stringify(message)}
`);
var log = (level, message) => process.stderr.write(`[unipus-classic] ${level} ${message}
`);
var nextId = 1;
var pending = /* @__PURE__ */ new Map();
function hostCall(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  write({ jsonrpc: "2.0", id, method, params });
  return promise;
}
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    return error.code ? `${error.code}: ${error.message}` : String(error.message ?? error);
  }
  return String(error);
}
function encryptLoginField(value) {
  const cipher = createCipheriv("aes-128-cbc", LOGIN_AES_KEY, LOGIN_AES_IV);
  return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("hex").toUpperCase();
}
var HostResponse = class {
  status;
  ok;
  body;
  headers;
  constructor(response) {
    this.status = Number(response?.status ?? 0);
    this.ok = this.status >= 200 && this.status < 300;
    this.body = typeof response?.body === "string" ? response.body : "";
    const lower = /* @__PURE__ */ new Map();
    for (const [key, value] of Object.entries(response?.headers ?? {})) {
      lower.set(String(key).toLowerCase(), String(value));
    }
    this.headers = { get: (name) => lower.get(String(name).toLowerCase()) ?? null };
  }
  async text() {
    return this.body;
  }
  async json() {
    return JSON.parse(this.body);
  }
};
function hostFetchFor(session, stage = "read") {
  return async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    delete headers.cookie;
    delete headers.host;
    delete headers["content-length"];
    const rawBody = init.body;
    const body = rawBody === void 0 || rawBody === null ? void 0 : typeof rawBody === "string" ? rawBody : String(rawBody);
    const response = await hostCall("cw.net.fetch", {
      session,
      method: String(init.method ?? "GET").toUpperCase(),
      url,
      headers,
      ...body !== void 0 ? { body, encoding: "raw" } : {},
      stage: init.stage ?? stage
    });
    return new HostResponse(response);
  };
}
async function follow(session, startUrl, maxHops = 8) {
  const fetcher = hostFetchFor(session);
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const response2 = await fetcher(url, {
      headers: { ...BROWSER_HEADERS, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    });
    const location = response2.headers.get("location");
    if (!location) return { url, response: response2, body: await response2.text() };
    url = new URL(location, url).toString();
  }
  const response = await hostFetchFor(session)(url);
  return { url, response, body: await response.text() };
}
var challenges = /* @__PURE__ */ new Map();
var challengeSeq = 0;
async function describe(params) {
  log("info", `describe framework=${params.framework_version ?? ""}`);
  return {
    module: { name: "courseflow-unipus-classic", version: MANIFEST.version, module_api: 1 },
    platform: MANIFEST.platform
  };
}
function authBegin(params) {
  challengeSeq += 1;
  const id = String(params.session ?? `ch_unipus_classic_${challengeSeq}_${Date.now()}`);
  challenges.set(id, { state: "waiting", at: Date.now() });
  return {
    challenge: {
      id,
      kind: "password",
      expires_at: Math.floor(Date.now() / 1e3) + 180,
      fields: [
        {
          name: "username",
          label: "U\u6821\u56ED\u8D26\u53F7",
          type: "text",
          required: true,
          autocomplete: "username",
          placeholder: "\u624B\u673A\u53F7\u6216\u90AE\u7BB1"
        },
        {
          name: "password",
          label: "\u5BC6\u7801",
          type: "password",
          required: true,
          autocomplete: "current-password"
        }
      ]
    }
  };
}
async function kickOtherSession(session) {
  try {
    log("warn", "single-session conflict, logging out the other session");
    await follow(session, `${UNIPUS_BASE}/logout?school_id=${encodeURIComponent(SCHOOL_ID)}&repeatLogin=1`, 6);
    await follow(session, `${UNIPUS_BASE}/user/comm/login?school_id=`, 4);
  } catch (error) {
    log("warn", `logout other session failed: ${errorText(error)}`);
  }
}
async function casLogin(session, username, password) {
  const service = `${UNIPUS_BASE}/user/student?school_id=${encodeURIComponent(SCHOOL_ID)}`;
  const loginPage = `${SSO_BASE}/sso/login?service=${encodeURIComponent(service)}`;
  const fetcher = hostFetchFor(session);
  await fetcher(loginPage, {
    headers: { ...BROWSER_HEADERS, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
  });
  const loginResponse = await fetcher(`${SSO_BASE}/sso/0.1/sso/cip/login`, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      origin: SSO_BASE,
      referer: loginPage,
      accept: "application/json, text/plain, */*",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: encryptLoginField(username),
      password: encryptLoginField(password),
      service,
      pcFlag: true,
      bindFlag: true,
      mfaCode: ""
    })
  });
  let login;
  try {
    login = JSON.parse(loginResponse.body);
  } catch {
    throw new Error(`SSO \u8FD4\u56DE\u975E JSON\uFF08HTTP ${loginResponse.status}\uFF09`);
  }
  if (login.code === "1506") {
    throw { code: "platform_verification_required", message: "\u5E73\u53F0\u8981\u6C42\u56FE\u5F62/\u6ED1\u5757\u9A8C\u8BC1\u7801\uFF0C\u8BF7\u5148\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u4E00\u6B21\u767B\u5F55\u540E\u91CD\u8BD5" };
  }
  if (login.code !== "0") {
    throw new Error(`SSO \u767B\u5F55\u5931\u8D25\uFF1Acode ${login.code ?? "?"} ${login.msg ?? ""}`.trim());
  }
  const ticket = login.rs?.serviceTicket;
  const openId = login.rs?.openid;
  if (!ticket) throw new Error("SSO \u672A\u8FD4\u56DE serviceTicket");
  return { service, ticket, openId, fetcher };
}
async function liveLogin(session, username, password) {
  if (!SCHOOL_ID) throw new Error("\u6A21\u5757\u8BBE\u7F6E\u7F3A\u5C11 school_id\uFF08\u6216\u5728 class_url \u4E2D\u5E26\u4E0A\uFF09");
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await kickOtherSession(session);
    const { service, ticket, openId, fetcher } = await casLogin(session, username, password);
    const redeem = `${service}${service.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
    await follow(session, redeem, 8);
    const tokenResponse = await fetcher(`${UNIPUS_BASE}/user/data/getToken`, {
      headers: { ...BROWSER_HEADERS, accept: "application/json, text/plain, */*", referer: service }
    });
    if (tokenResponse.status === 302 || !tokenResponse.ok) {
      lastError = {
        code: "platform_session_conflict",
        message: "\u8D26\u53F7\u5DF2\u5728\u5176\u4ED6\u8BBE\u5907/\u6D4F\u89C8\u5668\u767B\u5F55\uFF0C\u81EA\u52A8\u9000\u51FA\u540E\u4ECD\u65E0\u6CD5\u767B\u5F55"
      };
      continue;
    }
    let tokenJson;
    try {
      tokenJson = JSON.parse(tokenResponse.body);
    } catch {
      throw new Error(`getToken \u8FD4\u56DE\u975E JSON\uFF08HTTP ${tokenResponse.status}\uFF09`);
    }
    const token = tokenJson.token ?? tokenJson.data?.token;
    const resolvedOpenId = tokenJson.openId ?? tokenJson.data?.openId ?? openId;
    if (!token) {
      lastError = { code: "platform_session_conflict", message: "getToken \u672A\u8FD4\u56DE token" };
      continue;
    }
    if (CLASS_ID && DB_COURSE_ID) {
      try {
        await fetcher(
          `${UNIPUS_BASE}/user/student/mycourse/automaticJoinClass?classId=${CLASS_ID}&now=${Date.now()}&courseId=${DB_COURSE_ID}`,
          {
            headers: {
              ...BROWSER_HEADERS,
              accept: "text/html, */*; q=0.01",
              referer: service,
              "x-requested-with": "XMLHttpRequest"
            }
          }
        );
      } catch (error) {
        log("warn", `automaticJoinClass failed: ${errorText(error)}`);
      }
    }
    return { token: String(token), openId: String(resolvedOpenId ?? ""), displayName: username };
  }
  throw lastError ?? { code: "platform_session_conflict", message: "\u767B\u5F55\u5931\u8D25" };
}
async function authSubmit(params) {
  const id = String(params.challenge ?? "");
  const challenge = challenges.get(id);
  if (!challenge) return { state: "expired" };
  const fields = params.fields && typeof params.fields === "object" ? params.fields : {};
  const username = typeof fields.username === "string" ? fields.username.trim() : "";
  const password = typeof fields.password === "string" ? fields.password : "";
  if (!username || !password) return { state: "failed", message: "\u8BF7\u8F93\u5165\u8D26\u53F7\u548C\u5BC6\u7801" };
  try {
    const identity = await liveLogin(id, username, password);
    challenge.state = "connected";
    challenge.identity = { display_name: identity.displayName, account_raw: identity.openId };
    await hostCall("cw.state", {
      session: id,
      namespace: "auth",
      key: "session",
      value: {
        token: identity.token,
        open_id: identity.openId,
        school_id: SCHOOL_ID,
        connected_at: Date.now()
      }
    });
    log("info", `auth.submit connected openId=${identity.openId}`);
    return { state: "connected" };
  } catch (error) {
    challenge.state = "failed";
    challenge.message = errorText(error);
    log("warn", `auth.submit failed: ${challenge.message}`);
    return { state: "failed", message: challenge.message };
  }
}
function authPoll(params) {
  const challenge = challenges.get(String(params.challenge ?? ""));
  return challenge ? { state: challenge.state } : { state: "expired" };
}
function authComplete(params) {
  const id = String(params.challenge ?? "");
  const challenge = challenges.get(id);
  if (!challenge) throw { code: "invalid_params", message: "\u767B\u5F55\u6311\u6218\u4E0D\u5B58\u5728" };
  const identity = challenge.identity;
  challenges.delete(id);
  if (!identity) throw { code: "invalid_params", message: "\u767B\u5F55\u5C1A\u672A\u5B8C\u6210" };
  return identity;
}
async function authVerify(params) {
  try {
    const identity = await hostCall("cw.session.identity", { session: params.session });
    return {
      display_name: identity?.display_name ?? "U\u6821\u56ED\u666E\u901A\u7248",
      account_raw: identity?.account_raw ?? "",
      connected_at: identity?.connected_at ?? null
    };
  } catch {
    return { display_name: "U\u6821\u56ED\u666E\u901A\u7248", account_raw: "" };
  }
}
async function authKeepalive(params) {
  try {
    const state = await readAuth(String(params.session ?? ""));
    return { ok: Boolean(state?.token), expires_at: null };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}
async function readAuth(session) {
  const stored = await hostCall("cw.state", { session, namespace: "auth", key: "session" });
  const value = stored?.value;
  if (!value?.token) throw { code: "platform_login_expired", message: "\u8BF7\u5148\u8FDE\u63A5 U\u6821\u56ED\u666E\u901A\u7248" };
  return value;
}
function courseFromCatalog(html) {
  const idMatch = html.match(/var\s+course_id\s*=\s*"([^"]+)"/);
  const titleMatch = html.match(/<h3>([^<]+)<\/h3>/) ?? html.match(/<title>([^<]*)<\/title>/) ?? [];
  if (!idMatch) throw new Error("\u8BFE\u7A0B\u76EE\u5F55\u9875\u91CC\u6CA1\u6709\u627E\u5230 course_id");
  const name = String(titleMatch[1] ?? "U\u6821\u56ED\u8BFE\u7A0B").trim() || "U\u6821\u56ED\u8BFE\u7A0B";
  return { id: idMatch[1], name };
}
async function ensureContentSession(session, courseId) {
  const next = encodeURIComponent(`/courses/${courseId}/menus`);
  try {
    await follow(session, `${UCONTENT_BASE}/cas-auth/login/?next=${next}`, 6);
  } catch (error) {
    log("warn", `ucontent session failed: ${errorText(error)}`);
  }
}
async function loadCourse(session) {
  if (COURSE_ID) return { id: COURSE_ID, name: "U\u6821\u56ED\u8BFE\u7A0B" };
  if (!CLASS_URL) throw { code: "invalid_params", message: "\u8BF7\u5728\u6A21\u5757\u8BBE\u7F6E\u91CC\u914D\u7F6E class_url" };
  const auth = await readAuth(session);
  const fetcher = hostFetchFor(session);
  const response = await fetcher(CLASS_URL, {
    headers: { ...BROWSER_HEADERS, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", referer: CLASS_URL }
  });
  if (!response.ok) {
    throw { code: "platform_unavailable", message: `\u8BFE\u7A0B\u76EE\u5F55\u9875 HTTP ${response.status}` };
  }
  void auth;
  return courseFromCatalog(await response.text());
}
async function catalogCourses(params) {
  if (!CLASS_URL && !COURSE_ID) {
    throw { code: "invalid_params", message: "\u8BF7\u5728\u6A21\u5757\u8BBE\u7F6E\u91CC\u914D\u7F6E class_url \u6216 course_id" };
  }
  await readAuth(String(params.session ?? ""));
  const course = await loadCourse(String(params.session ?? ""));
  return {
    courses: [
      {
        id: course.id,
        recruit_id: course.id,
        name: course.name,
        kind: "shared",
        kind_label: "\u5171\u4EAB\u8BFE",
        family: "shared",
        progress: null,
        outline_available: true
      }
    ]
  };
}
async function fetchText(session, url, headers, stage = "read") {
  const response = await hostFetchFor(session, stage)(url, {
    headers: { ...BROWSER_HEADERS, ...headers }
  });
  return { response, text: await response.text() };
}
function annotatorHeaders(auth) {
  return {
    accept: "application/json, text/plain, */*",
    "x-annotator-auth-token": auth.token,
    authorization: auth.token
  };
}
async function catalogUnits(params) {
  const session = String(params.session ?? "");
  const auth = await readAuth(session);
  const course = await loadCourse(session);
  const courseId = course.id;
  if (params.course?.id && params.course.id !== courseId) {
    throw { code: "not_found", message: "\u8BFE\u7A0B\u4E0D\u5B58\u5728" };
  }
  await ensureContentSession(session, courseId);
  const treeResult = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/course/${courseId}/default/`,
    { accept: "application/json, text/plain, */*" }
  );
  let treeJson;
  try {
    treeJson = JSON.parse(treeResult.text);
  } catch {
    throw {
      code: "platform_unavailable",
      message: `\u8BFE\u7A0B\u6811\u8FD4\u56DE\u975E JSON\uFF08HTTP ${treeResult.response.status}\uFF09`
    };
  }
  const tree = typeof treeJson.course === "string" ? JSON.parse(treeJson.course) : treeJson.course;
  const version = String(treeJson.publish_version ?? treeJson.version ?? "");
  if (version) {
    await hostCall("cw.state", {
      session,
      namespace: "course",
      key: courseId,
      value: { version, at: Date.now() }
    });
  }
  const units = [];
  for (const unit of tree?.units ?? []) {
    const unitId = String(unit.url ?? "");
    let leafs = {};
    try {
      const progress = await fetchText(
        session,
        `${UCONTENT_BASE}/course/api/v2/course_progress/${courseId}/${unitId}/${auth.open_id}/default/`,
        annotatorHeaders(auth)
      );
      const parsed = JSON.parse(progress.text);
      leafs = parsed?.rt?.leafs ?? {};
    } catch (error) {
      log("warn", `progress ${unitId} failed: ${errorText(error)}`);
    }
    const walk = (node, parentId) => {
      if (node?.role === "group" && node.url) {
        const tab = String(node.tab_type ?? "");
        const base = String(node.base ?? "");
        if (tab !== "text" && tab !== "video" && tab !== "task") {
          for (const child of node.children ?? []) walk(child, String(node.url));
          return;
        }
        if (base === "quiz-paper-link") {
          for (const child of node.children ?? []) walk(child, String(node.url));
          return;
        }
        const kind = tab === "video" ? "video" : tab === "task" ? "document" : "reading";
        const pass = Number(leafs?.[node.url]?.state?.pass ?? 0);
        units.push({
          id: `${node.url}::${base || tab}`,
          name: String(node.name ?? node.url).trim(),
          chapter_id: unitId,
          chapter_name: `${String(unit.caption ?? "").trim()} ${String(unit.name ?? "").trim()}`.trim(),
          lesson_id: parentId,
          kind,
          duration_seconds: 0,
          watched_seconds: 0,
          state: pass === 1 ? "completed" : "not_started",
          video_id: kind === "video" ? String(node.url) : null,
          selectable: true,
          selectable_note: base
        });
      }
      for (const child of node?.children ?? []) walk(child, String(node.url ?? parentId));
    };
    for (const child of unit.children ?? []) walk(child, unitId);
  }
  log("info", `catalog.units course=${courseId} units=${units.length}`);
  return { units };
}
function decodeContent(payload) {
  const content = payload?.content;
  const k = payload?.k;
  if (typeof content !== "string" || !content.startsWith("unipus.") || !k) return null;
  const hex = content.slice("unipus.".length);
  const key = Buffer.from(`${CONTENT_KEY_PREFIX}${k}`, "utf8");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const text = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString("utf8").replace(/\u0000+$/g, "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function collectQids(indexMap) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.qid === "string" && node.qid) out.push(node.qid);
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  };
  walk(indexMap);
  return out;
}
function taskAnswers(decoded) {
  if (!decoded || typeof decoded !== "object") return [];
  const out = [];
  for (const group of Object.values(decoded)) {
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
async function groupState(session, courseId, groupId, auth) {
  const { text } = await fetchText(
    session,
    `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/progress/v2/`,
    annotatorHeaders(auth)
  );
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function studyLeaf(session, courseId, unit, auth) {
  const groupId = String(unit.id ?? "").split("::")[0];
  if (!groupId) throw { code: "invalid_params", message: "\u7F3A\u5C11 group id" };
  let version = "default";
  try {
    const stored = await hostCall("cw.state", { session, namespace: "course", key: courseId });
    if (stored?.value?.version) version = String(stored.value.version);
  } catch {
  }
  const response = await hostFetchFor(session, "save_study")(
    `${UCONTENT_BASE}/api/mobile/user_group/${courseId}/${groupId}/progress/`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        "content-type": "application/json",
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`
      },
      body: JSON.stringify({
        status: 1,
        rid: `flowengine:studyStatus:1:${groupId}`,
        groupId,
        version: "default"
      })
    }
  );
  let payload = null;
  try {
    payload = JSON.parse(response.body);
  } catch {
  }
  log("info", `finish group ${groupId} v=${version} HTTP ${response.status} ${response.body.slice(0, 120)}`);
  const code = Number(payload?.code ?? 0);
  if (code === 600001 || code === 600002) {
    return {
      status: "in_progress",
      wait_ms: 6e4,
      checkpoint: { phase: "rate_limited" },
      evidence: { rate_limited: true, message: payload?.msg ?? "" }
    };
  }
  if (code !== 0) {
    return {
      status: "needs_human",
      reason: `\u8FDB\u5EA6\u5199\u5165\u5931\u8D25\uFF1Acode ${code} ${payload?.msg ?? response.body.slice(0, 120)}`
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await groupState(session, courseId, groupId, auth);
  const pass = Number(state?.data?.state?.state ?? 0);
  if (pass === 1) {
    return { status: "completed", evidence: { platform_confirmed: true, pass }, checkpoint: { phase: "done" } };
  }
  return {
    status: "in_progress",
    wait_ms: 2e3,
    checkpoint: { phase: "submitted" }
  };
}
async function studyTask(session, courseId, unit, auth) {
  const groupId = String(unit.id ?? "").split("::")[0];
  const summary = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/pc/summary/${courseId}/${groupId}/default/`,
    annotatorHeaders(auth)
  );
  let summaryJson = null;
  try {
    summaryJson = JSON.parse(summary.text);
  } catch {
  }
  const qids = collectQids(summaryJson?.summary?.indexMap);
  if (qids.length === 0) {
    return { status: "needs_human", reason: "\u9898\u7EC4\u6CA1\u6709\u8FD4\u56DE qid" };
  }
  const content = await fetchText(
    session,
    `${UCONTENT_BASE}/course/api/v3/content/${courseId}/${groupId}/default/`,
    { accept: "application/json, text/plain, */*" }
  );
  let contentJson = null;
  try {
    contentJson = JSON.parse(content.text);
  } catch {
  }
  const decoded = decodeContent(contentJson);
  const answers = taskAnswers(decoded);
  if (answers.length === 0) {
    return { status: "needs_human", reason: "\u9898\u7EC4\u5185\u5BB9\u6CA1\u6709\u53EF\u7528\u7684\u53C2\u8003\u7B54\u6848" };
  }
  return {
    status: "needs_human",
    reason: `\u666E\u901A\u7248\u63D0\u4EA4\u63A5\u53E3\u5C1A\u672A\u8054\u8C03\uFF0C\u5DF2\u8BFB\u53D6 ${qids.length} \u4E2A qid / ${answers.length} \u6761\u53C2\u8003\u7B54\u6848`,
    evidence: { qids, answers: answers.slice(0, 10) }
  };
}
async function studyStep(params) {
  const session = String(params.session ?? "");
  const unit = params.unit ?? {};
  const rawId = String(unit.id ?? "");
  if (!rawId) throw { code: "invalid_params", message: "\u7F3A\u5C11\u5355\u5143 id" };
  const auth = await readAuth(session);
  const course = await loadCourse(session);
  if (String(unit.kind) === "document") {
    return studyTask(session, course.id, unit, auth);
  }
  return studyLeaf(session, course.id, unit, auth);
}
async function dispatch(method, params) {
  switch (method) {
    case "platform.describe":
      return describe(params);
    case "auth.begin":
      return authBegin(params);
    case "auth.submit":
      return authSubmit(params);
    case "auth.poll":
      return authPoll(params);
    case "auth.complete":
      return authComplete(params);
    case "auth.verify":
      return authVerify(params);
    case "auth.keepalive":
      return authKeepalive(params);
    case "catalog.courses":
      return catalogCourses(params);
    case "catalog.units":
      return catalogUnits(params);
    case "study.step":
      return studyStep(params);
    default:
      throw { code: "unsupported_operation", message: `U\u6821\u56ED\u666E\u901A\u7248\u672A\u5B9E\u73B0 ${method}` };
  }
}
async function handleRequest(request) {
  try {
    const result = await dispatch(request.method, request.params ?? {});
    write({ jsonrpc: "2.0", id: request.id, result: result ?? {} });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: error?.code ?? "module_error",
        message: error?.message ?? String(error)
      }
    });
  }
}
var lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log("warn", "ignored non-JSON input");
    return;
  }
  if (message.id !== void 0 && (message.result !== void 0 || message.error !== void 0)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
    return;
  }
  if (typeof message.method === "string" && message.id !== void 0) {
    void handleRequest(message);
  }
});
lines.on("close", () => process.exit(0));
