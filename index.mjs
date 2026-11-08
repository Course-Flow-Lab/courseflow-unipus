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
var BROWSER_STUDY = SETTINGS.browser_study !== false;
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
async function fetchUserState(session, courseId, groupId, auth) {
  const { text } = await fetchText(
    session,
    `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/`,
    annotatorHeaders(auth)
  );
  try {
    return JSON.parse(text)?.data ?? null;
  } catch {
    return null;
  }
}
function findChoiceGroup(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  for (const value of Object.values(decoded)) {
    if (!value || !Array.isArray(value.questions)) continue;
    const category = String(value.category ?? "");
    if (category === "singlechoice" || category === "truefalse" || category === "choice") {
      return { group: value, category };
    }
  }
  return null;
}
async function solveChoiceQuestions(session, group) {
  const questions = (group.questions ?? []).map((question, index) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
    options: (question?.options ?? []).map((option) => ({
      caption: String(option?.caption ?? ""),
      text: stripHtml(option?.content?.html)
    }))
  }));
  if (questions.length === 0) return null;
  const prompt = [
    "\u4F60\u662F U\u6821\u56ED\u82F1\u8BED\u7EC3\u4E60\u7B54\u9898\u52A9\u624B\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["\u7B54\u6848"]}\u3002',
    "\u9009\u62E9\u9898 texts \u8FD4\u56DE\u6B63\u786E\u9009\u9879\u7684 caption\uFF08A/B/C/D\uFF09\uFF0C\u5982\u679C\u4E0D\u786E\u5B9A caption\uFF0C\u8FD4\u56DE\u9009\u9879\u539F\u6587\u3002",
    JSON.stringify(questions)
  ].join("\n");
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall("cw.ai.generate", {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}
\u4E0A\u6B21\u8F93\u51FA\u4E0D\u662F\u5408\u6CD5 JSON\uFF1B\u8FD9\u6B21\u53EA\u8F93\u51FA JSON\u3002`
    });
    const raw = String(response?.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out = {};
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? "");
    const texts = Array.isArray(item.texts) ? item.texts.map(String) : Array.isArray(item.answers) ? item.answers.map(String) : [];
    if (id) out[id] = texts;
  }
  return out;
}
function findQuestionGroup(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  for (const value of Object.values(decoded)) {
    if (value && Array.isArray(value.questions)) return value;
  }
  return null;
}
function pageMeta(indexMap, pageId) {
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (typeof node.qid === "string") {
      found = { qid: node.qid, rules: node.rules ?? [] };
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(indexMap?.[pageId] ?? {});
  return found ?? { rules: [] };
}
async function solveTextQuestions(session, group) {
  const questions = (group.questions ?? []).map((question, index) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html)
  }));
  if (questions.length === 0) return null;
  const prompt = [
    "\u4F60\u662F U\u6821\u56ED\u82F1\u8BED\u7EC3\u4E60\u7B54\u9898\u52A9\u624B\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["\u7B54\u6848"]}\u3002',
    "\u7B80\u7B54\u9898/\u586B\u7A7A\u9898\u7ED9\u51FA\u7B80\u77ED\u3001\u76F4\u63A5\u3001\u7B26\u5408\u9898\u610F\u7684\u82F1\u6587\u7B54\u6848\u3002",
    JSON.stringify(questions)
  ].join("\n");
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall("cw.ai.generate", {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}
\u4E0A\u6B21\u8F93\u51FA\u4E0D\u662F\u5408\u6CD5 JSON\uFF1B\u8FD9\u6B21\u53EA\u8F93\u51FA JSON\u3002`
    });
    const raw = String(response?.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      parsed = JSON.parse(raw);
      break;
    } catch {
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out = {};
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? "");
    const texts = Array.isArray(item.texts) ? item.texts.map(String) : Array.isArray(item.answers) ? item.answers.map(String) : [];
    if (id) out[id] = texts;
  }
  return out;
}
function scriptAnswers(decoded) {
  const out = [];
  if (!decoded || typeof decoded !== "object") return out;
  for (const group of Object.values(decoded)) {
    for (const content of group?.content ?? []) {
      const script = content?.audio?.script;
      const html = typeof script === "string" ? script : script?.html;
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
function browserStudyTask(mode, values) {
  return (async () => {
    const doc = document;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (node) => Boolean(node && node.offsetParent !== null);
    const clickText = (text) => {
      const node = Array.from(doc.querySelectorAll("*")).find(
        (n) => n.children.length === 0 && (n.textContent || "").trim() === text && visible(n)
      );
      if (!node) return false;
      node.click();
      return true;
    };
    const dismissOverlays = async () => {
      doc.querySelectorAll('.bfg-mask, .layui-layer, [class*="tooltip"]').forEach((el) => el.remove());
      clickText("\u6211\u77E5\u9053\u4E86");
      await sleep(200);
      clickText("\u786E\u5B9A");
      await sleep(400);
    };
    const waitFor = async (selector, timeoutMs = 15e3) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const nodes = Array.from(doc.querySelectorAll(selector));
        if (nodes.length) return nodes;
        clickText("\u6211\u77E5\u9053\u4E86");
        clickText("\u786E\u5B9A");
        await sleep(300);
      }
      return [];
    };
    const submitAndConfirm = async () => {
      await dismissOverlays();
      const barButtons = Array.from(doc.querySelectorAll('button[class*="submit-bar-pc--btn"]'));
      const submit = barButtons[barButtons.length - 1] ?? Array.from(doc.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "\u63D0\u4EA4");
      submit?.click();
      const started = Date.now();
      let confirmed = false;
      while (Date.now() - started < 8e3) {
        await sleep(400);
        if (clickText("\u786E\u8BA4")) {
          confirmed = true;
          break;
        }
      }
      await sleep(1e3);
      const tail = String(doc.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      return { submitted: Boolean(submit), confirmed, message: confirmed ? "" : tail.slice(-180) };
    };
    await dismissOverlays();
    if (mode === "choice") {
      const radios = await waitFor('input[type="radio"]');
      const groups = [];
      const byName = /* @__PURE__ */ new Map();
      for (const radio of radios) {
        const name = String(radio.name || "");
        if (!name) continue;
        if (!byName.has(name)) {
          const group = [];
          byName.set(name, group);
          groups.push(group);
        }
        byName.get(name)?.push(radio);
      }
      const picked = [];
      values.slice(0, groups.length).forEach((caption, index) => {
        const group = groups[index];
        const target = group.find((radio) => String(radio.value).toUpperCase() === caption.toUpperCase());
        if (!target) return;
        const label = target.closest("label") ?? target;
        label.click();
        picked.push(String(target.value));
      });
      if (groups.length === 0 || picked.length === 0) {
        return { mode, groups: groups.length, picked, submitted: false, confirmed: false, error: "no_choices" };
      }
      await sleep(800);
      const result2 = await submitAndConfirm();
      return { mode, groups: groups.length, picked, ...result2 };
    }
    const inputs = await waitFor('input[type="text"]');
    if (inputs.length === 0) {
      return { mode, inputs: 0, filled: 0, submitted: false, confirmed: false, error: "no_inputs" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    inputs.slice(0, values.length).forEach((input, index) => {
      if (descriptor?.set) descriptor.set.call(input, values[index]);
      else input.value = values[index];
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    await sleep(800);
    const result = await submitAndConfirm();
    return { mode, inputs: inputs.length, filled: inputs.filter((i) => i.value).length, ...result };
  })();
}
function isSinglePageTask(questionsList) {
  const pages = new Set(
    (questionsList ?? []).map((item) => String(item?.path?.[0]?.[1] ?? ""))
  );
  return pages.size <= 1;
}
function coursewareUrl(courseId, groupId, questionsList) {
  const parentPath = questionsList?.[0]?.path?.[1] ?? [];
  const coursewarePath = [...parentPath, groupId];
  return `${UCONTENT_BASE}/_pc_default/pc.html?cid=${CLASS_ID}&appid=5&schId=${SCHOOL_ID}#/${courseId}/courseware/${coursewarePath.join("/")}/p_1`;
}
async function browserStudy(session, courseId, groupId, url, mode, values, auth, minScorePct) {
  let opened = null;
  try {
    opened = await hostCall("cw.browser.open", { session, url, purpose: "study" });
  } catch (error) {
    return { status: "needs_human", reason: `\u5B98\u65B9\u6D4F\u89C8\u5668\u4E0D\u53EF\u7528\uFF1A${errorText(error)}` };
  }
  const page = opened?.page;
  if (!page) return { status: "needs_human", reason: "\u5B98\u65B9\u6D4F\u89C8\u5668\u6CA1\u6709\u8FD4\u56DE\u9875\u9762\u53E5\u67C4" };
  let result = null;
  try {
    const expression = `(${browserStudyTask.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(values)})`;
    result = await hostCall("cw.browser.evaluate", {
      session,
      page,
      stage: "save_study",
      expression
    });
    log("info", `browser ${mode} ${groupId}: ${JSON.stringify(result).slice(0, 200)}`);
    await new Promise((resolve) => setTimeout(resolve, 4e3));
  } catch (error) {
    result = { error: errorText(error) };
    log("warn", `browser ${mode} ${groupId} failed: ${errorText(error)}`);
  } finally {
    await hostCall("cw.browser.close", { session, page }).catch(() => {
    });
  }
  const state = await groupState(session, courseId, groupId, auth);
  const pass = Number(state?.data?.state?.state ?? 0);
  const score = state?.data?.state?.score_avg ?? null;
  if (pass === 1 && (minScorePct === 0 || Number(score ?? 0) >= minScorePct * 100)) {
    return {
      status: "completed",
      evidence: { platform_confirmed: true, score, browser: true, browser_result: result },
      checkpoint: { phase: "done" }
    };
  }
  const detail = String(result?.message ?? "").trim();
  return {
    status: "needs_human",
    reason: `\u6D4F\u89C8\u5668\u63D0\u4EA4\u540E\u5E73\u53F0\u672A\u786E\u8BA4\uFF08state ${pass}, score ${score ?? "?"}\uFF09${detail ? `\uFF1A${detail}` : ""}`,
    evidence: { browser_result: result, state: pass, score }
  };
}
async function studyFillblankBrowser(session, courseId, groupId, decoded, questionGroup, questionsList, auth, minScorePct) {
  let answers = scriptAnswers(decoded);
  if (answers.length === 0) {
    const solved = await solveTextQuestions(session, questionGroup);
    if (solved) {
      answers = (questionGroup.questions ?? []).map(
        (_, index) => solved[String(index)]?.[0] ?? ""
      );
    }
  }
  if (answers.length === 0) {
    return { status: "needs_human", reason: "\u586B\u7A7A\u9898\u6CA1\u6709\u7B54\u6848\u6765\u6E90" };
  }
  const result = await browserStudy(
    session,
    courseId,
    groupId,
    coursewareUrl(courseId, groupId, questionsList),
    "fill",
    answers,
    auth,
    minScorePct
  );
  return {
    ...result,
    evidence: { ...result.evidence, fill_answers: answers }
  };
}
function matchChoiceCaption(options, texts) {
  const normalized = texts.map((value) => String(value).trim()).filter(Boolean);
  for (const value of normalized) {
    const exactCaption = options.find(
      (option) => String(option?.caption ?? "").trim().toLowerCase() === value.toLowerCase()
    );
    if (exactCaption) return String(exactCaption.caption);
  }
  for (const value of normalized) {
    const exactText = options.find(
      (option) => stripHtml(option?.content?.html).toLowerCase() === value.toLowerCase()
    );
    if (exactText) return String(exactText.caption);
  }
  for (const value of normalized) {
    if (value.length < 4) continue;
    const partial = options.find((option) => {
      const text = stripHtml(option?.content?.html).toLowerCase();
      return text.includes(value.toLowerCase()) || value.toLowerCase().includes(text);
    });
    if (partial) return String(partial.caption);
  }
  return String(options[0]?.caption ?? "A");
}
function choiceCaptions(group, solved) {
  const questions = group?.questions ?? [];
  return questions.map((question, index) => {
    const options = question.options ?? [];
    return matchChoiceCaption(options, solved[String(index)] ?? []);
  });
}
async function studyChoiceBrowser(session, courseId, groupId, decoded, questionsList, auth, minScorePct) {
  const choice = findChoiceGroup(decoded);
  if (!choice) return { status: "needs_human", reason: "\u6CA1\u6709\u627E\u5230\u9009\u62E9\u9898\u7EC4" };
  const solved = await solveChoiceQuestions(session, choice.group);
  if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u9009\u62E9\u9898\u7B54\u6848" };
  const captions = choiceCaptions(choice.group, solved);
  const result = await browserStudy(
    session,
    courseId,
    groupId,
    coursewareUrl(courseId, groupId, questionsList),
    "choice",
    captions,
    auth,
    minScorePct
  );
  return {
    ...result,
    evidence: { ...result.evidence, choice_answers: captions }
  };
}
async function studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct, precomputedValues) {
  if (!isSinglePageTask(questionsList)) {
    return { status: "needs_human", reason: "\u591A\u9875\u9898\u7EC4\u6682\u4E0D\u652F\u6301 API \u63D0\u4EA4" };
  }
  const category = String(questionGroup.category ?? "").toLowerCase();
  const isFill = /fillblank/.test(category);
  const choice = isFill ? null : findChoiceGroup(decoded);
  let values = precomputedValues ?? [];
  if (isFill) {
    if (values.length === 0) values = scriptAnswers(decoded);
    if (values.length === 0) {
      const solved = await solveTextQuestions(session, questionGroup);
      if (!solved) return { status: "needs_human", reason: "fillblankScoop \u6CA1\u6709\u7B54\u6848\u6765\u6E90" };
      values = (questionGroup.questions ?? []).map((_, index) => solved[String(index)]?.[0] ?? "");
    }
  } else if (choice) {
    if (values.length === 0) {
      const solved = await solveChoiceQuestions(session, choice.group);
      if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u9009\u62E9\u9898\u7B54\u6848" };
      values = choiceCaptions(choice.group, solved);
    }
  } else {
    return { status: "needs_human", reason: `\u672A\u652F\u6301\u7684\u5BA2\u89C2\u9898\u7C7B\u578B ${category || "unknown"}` };
  }
  const questions = questionGroup.questions ?? [];
  if (values.length === 0) return { status: "needs_human", reason: "\u6CA1\u6709\u6784\u9020\u51FA\u7B54\u6848" };
  const userState = await fetchUserState(session, courseId, groupId, auth);
  const version = String(
    userState?.state?.version ?? userState?.version ?? Math.floor(Date.now() / 1e3)
  );
  const firstQid = collectQids(indexMap)[0];
  if (!firstQid) return { status: "needs_human", reason: "\u9898\u7EC4\u6CA1\u6709\u8FD4\u56DE qid" };
  const pages = {};
  const answerList = {};
  const answers = {};
  for (let index = 0; index < questions.length; index += 1) {
    const path = questionsList[index]?.path?.[0] ?? [];
    const pageId = String(path[1] ?? "p_1");
    const meta = pageMeta(indexMap, pageId);
    const qid = meta.qid ?? firstQid;
    const rule = String(
      (Array.isArray(meta.rules) ? meta.rules[index] ?? meta.rules[0] : meta.rules) ?? (isFill ? "in" : "eq")
    );
    const value = values[index] ?? "";
    answerList[String(index)] = {
      student_answer: value,
      isDone: true,
      version: "v2",
      rule
    };
    answers[String(index)] = {
      student_answer: value,
      isDone: true,
      version: "v2",
      rule,
      user_answer: {
        qid,
        rule,
        answer: { index, answer: value, version: "v2" },
        content: "",
        id: `${qid}-${index}`,
        offset: 0
      }
    };
    const existingComponent = userState?.state?.[pageId] ? Object.keys(userState.state[pageId])[0] : "";
    const component = existingComponent || "c_1_1";
    pages[pageId] ??= { [component]: { student_answers: {} } };
    pages[pageId][component].student_answers[String(index)] = value;
  }
  const stateObj = {
    version,
    ...pages,
    __EXTEND_DATA__: { __SUMMARY__: { answerList } }
  };
  const payload = {
    enable_mistake: false,
    version: "default",
    record_version: version,
    state: JSON.stringify(stateObj),
    specific_scores: questions.map(() => null),
    answers
  };
  const submit = await hostFetchFor(session, "save_study")(
    `${UCONTENT_BASE}/course/api/v3/submit/${courseId}/${groupId}/`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        "content-type": "application/json",
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`
      },
      body: JSON.stringify(payload)
    }
  );
  let submitJson = null;
  try {
    submitJson = JSON.parse(submit.body);
  } catch {
  }
  log("info", `submit ${groupId} HTTP ${submit.status} code ${submitJson?.code ?? "?"}`);
  if (submitJson?.code !== 0) {
    return {
      status: "needs_human",
      reason: `\u9898\u7EC4\u63D0\u4EA4\u5931\u8D25\uFF1Acode ${submitJson?.code ?? "?"} ${submitJson?.msg ?? submit.body.slice(0, 160)}`
    };
  }
  const info = submitJson?.data?.submit_info;
  const submitState = Number(info?.state?.state ?? 0);
  const scorePct = Number(info?.state?.real_score_pct ?? info?.state?.score_pct ?? 0);
  const score = info?.state?.score ?? null;
  if (submitState === 1 && (minScorePct === 0 || scorePct >= minScorePct)) {
    return {
      status: "completed",
      evidence: { platform_confirmed: true, score, score_pct: scorePct, min_score_pct: minScorePct, api: true },
      checkpoint: { phase: "done" }
    };
  }
  return {
    status: "needs_human",
    reason: `\u9898\u7EC4\u5DF2\u63D0\u4EA4\u4F46\u672A\u8FBE\u5230\u901A\u8FC7\u6761\u4EF6\uFF08score_pct ${scorePct}, min ${minScorePct}\uFF09`,
    evidence: { score, score_pct: scorePct, min_score_pct: minScorePct }
  };
}
async function studyTask(session, courseId, unit, auth) {
  const groupId = String(unit.id ?? "").split("::")[0];
  let minScorePct = 0;
  let progressData = null;
  try {
    const progress = await fetchText(
      session,
      `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/progress/v2/`,
      annotatorHeaders(auth)
    );
    progressData = JSON.parse(progress.text)?.data ?? null;
    minScorePct = Number(progressData?.flowStrategy?.task_mini_score_pct ?? 0);
  } catch {
    minScorePct = 0;
  }
  const now = Math.floor(Date.now() / 1e3);
  const startTime = Number(progressData?.flowStrategy?.startTime ?? 0);
  const endTime = Number(progressData?.flowStrategy?.endTime ?? 0);
  if (startTime > 0 && now < startTime) {
    return {
      status: "blocked",
      reason: "\u5B66\u4E60\u5F00\u59CB\u65F6\u95F4\u672A\u5230\uFF0C\u5E73\u53F0\u4E0D\u5141\u8BB8\u63D0\u4EA4",
      wait_ms: Math.min((startTime - now) * 1e3, 36e5),
      evidence: { start_time: startTime, now }
    };
  }
  if (endTime > 0 && now > endTime) {
    return {
      status: "blocked",
      reason: "\u5B66\u4E60\u622A\u6B62\u65F6\u95F4\u5DF2\u8FC7\uFF0C\u5E73\u53F0\u4E0D\u5141\u8BB8\u63D0\u4EA4",
      evidence: { end_time: endTime, now }
    };
  }
  if (minScorePct > 0 && SETTINGS.enable_task_submit !== true && !BROWSER_STUDY) {
    return {
      status: "needs_human",
      reason: `\u9898\u7EC4\u6709\u8BA1\u5206\u8981\u6C42\uFF08min_score_pct=${minScorePct}\uFF09\uFF0C\u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED`
    };
  }
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
  const indexMap = summaryJson?.summary?.indexMap ?? {};
  const questionsList = summaryJson?.summary?.questionsList ?? [];
  const qids = collectQids(indexMap);
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
  const questionGroup = findQuestionGroup(decoded);
  if (!questionGroup) {
    return { status: "needs_human", reason: "\u9898\u7EC4\u5185\u5BB9\u91CC\u6CA1\u6709\u9898\u76EE" };
  }
  const category = String(questionGroup.category ?? "").toLowerCase();
  const isFill = /fillblank/.test(category);
  const isChoice = category === "singlechoice" || category === "truefalse" || category === "true_false" || category === "choice";
  if (isFill) {
    if (BROWSER_STUDY) {
      const browserResult = await studyFillblankBrowser(
        session,
        courseId,
        groupId,
        decoded,
        questionGroup,
        questionsList,
        auth,
        minScorePct
      );
      if (browserResult.status === "completed") return browserResult;
      const rawState = browserResult?.evidence?.state;
      if (!(rawState === void 0 || rawState === null || Number(rawState) === 0)) return browserResult;
      if (!isSinglePageTask(questionsList)) {
        return { ...browserResult, reason: `${browserResult.reason}\uFF1B\u591A\u9875\u9898\u7EC4\u6682\u4E0D\u652F\u6301 API \u515C\u5E95` };
      }
      log("warn", `browser did not submit ${groupId}, falling back to API`);
      const apiResult = await studyObjectiveApi(
        session,
        courseId,
        groupId,
        decoded,
        questionGroup,
        questionsList,
        indexMap,
        auth,
        minScorePct,
        browserResult?.evidence?.fill_answers
      );
      if (apiResult.status === "completed") {
        return { ...apiResult, evidence: { ...apiResult.evidence, fallback: "browser_to_api" } };
      }
      return apiResult;
    }
    if (SETTINGS.enable_task_submit !== true) {
      return { status: "needs_human", reason: "\u586B\u7A7A\u9898\u4F1A\u8BA1\u5206\uFF0CAPI \u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED" };
    }
    return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
  }
  if (isChoice) {
    if (BROWSER_STUDY) {
      const browserResult = await studyChoiceBrowser(
        session,
        courseId,
        groupId,
        decoded,
        questionsList,
        auth,
        minScorePct
      );
      if (browserResult.status === "completed") return browserResult;
      const rawState = browserResult?.evidence?.state;
      if (!(rawState === void 0 || rawState === null || Number(rawState) === 0)) return browserResult;
      if (!isSinglePageTask(questionsList)) {
        return { ...browserResult, reason: `${browserResult.reason}\uFF1B\u591A\u9875\u9898\u7EC4\u6682\u4E0D\u652F\u6301 API \u515C\u5E95` };
      }
      log("warn", `browser did not submit ${groupId}, falling back to API`);
      const apiResult = await studyObjectiveApi(
        session,
        courseId,
        groupId,
        decoded,
        questionGroup,
        questionsList,
        indexMap,
        auth,
        minScorePct,
        browserResult?.evidence?.choice_answers
      );
      if (apiResult.status === "completed") {
        return { ...apiResult, evidence: { ...apiResult.evidence, fallback: "browser_to_api" } };
      }
      return apiResult;
    }
    if (SETTINGS.enable_task_submit !== true) {
      return { status: "needs_human", reason: "\u9009\u62E9\u9898\u4F1A\u8BA1\u5206\uFF0CAPI \u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED" };
    }
    return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
  }
  const objective = /single|truefalse|true_false|fillblank|sequence|matching|choice/.test(category);
  if (objective && SETTINGS.enable_task_submit !== true) {
    return {
      status: "needs_human",
      reason: `\u5BA2\u89C2\u9898\uFF08${category || "unknown"}\uFF09\u4F1A\u8BA1\u5206\uFF0C\u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED`
    };
  }
  const choice = objective ? findChoiceGroup(decoded) : null;
  const solved = choice ? await solveChoiceQuestions(session, choice.group) : await solveTextQuestions(session, questionGroup);
  if (!solved) {
    return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u7B54\u6848" };
  }
  const userState = await fetchUserState(session, courseId, groupId, auth);
  const questions = questionGroup.questions ?? [];
  const answers = {};
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const path = questionsList[index]?.path?.[0] ?? [];
    const pageId = String(path[1] ?? "");
    const meta = pageMeta(indexMap, pageId);
    const qid = meta.qid;
    const ruleValue = Array.isArray(meta.rules) ? meta.rules[index] ?? meta.rules[0] : meta.rules;
    const texts = solved[String(index)] ?? [];
    let answerValue;
    if (choice) {
      answerValue = matchChoiceCaption(question.options ?? [], texts);
    } else {
      answerValue = texts[0] ?? "Answered.";
    }
    if (qid) {
      answers[String(index)] = {
        isDone: true,
        student_answer: { answers: answerValue },
        user_answer: {
          qid,
          rule: ruleValue,
          answer: {
            index,
            answer: { student_answer: { answers: answerValue } },
            version: "v3"
          },
          content: ""
        }
      };
    } else {
      answers[String(index)] = { score: 0 };
    }
  }
  const stateObj = {
    version: String(userState?.state?.version ?? "default"),
    __EXTEND_DATA__: {
      base: String(userState?.state?.__EXTEND_DATA__?.base ?? userState?.base ?? ""),
      commit: String(userState?.state?.__EXTEND_DATA__?.commit ?? userState?.commit ?? "")
    },
    __SUMMARY__: {
      firstPass: {
        score_pct: progressData?.first_pass?.score_pct ?? 1,
        datetime: progressData?.first_pass?.datetime ?? 0
      }
    }
  };
  const payload = {
    enable_mistake: false,
    version: "default",
    record_version: stateObj.version,
    base: String(userState?.commit ?? userState?.base ?? ""),
    state: JSON.stringify(stateObj),
    specific_scores: questions.map(() => null),
    answers
  };
  const submit = await hostFetchFor(session, "save_study")(
    `${UCONTENT_BASE}/course/api/v3/submit/${courseId}/${groupId}/`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        ...annotatorHeaders(auth),
        "content-type": "application/json",
        origin: UCONTENT_BASE,
        referer: `${UCONTENT_BASE}/_pc_default/pc.html`
      },
      body: JSON.stringify(payload)
    }
  );
  let submitJson = null;
  try {
    submitJson = JSON.parse(submit.body);
  } catch {
  }
  log("info", `submit ${groupId} HTTP ${submit.status} code ${submitJson?.code ?? "?"}`);
  if (submitJson?.code !== 0) {
    return {
      status: "needs_human",
      reason: `\u9898\u7EC4\u63D0\u4EA4\u5931\u8D25\uFF1Acode ${submitJson?.code ?? "?"} ${submitJson?.message ?? submit.body.slice(0, 160)}`
    };
  }
  const info = submitJson?.data?.submit_info;
  const submitState = Number(info?.state?.state ?? 0);
  const scorePct = Number(info?.state?.real_score_pct ?? info?.state?.score_pct ?? 0);
  const score = info?.state?.score ?? null;
  const needed = Math.max(minScorePct, 0.6);
  if (submitState === 1 && (minScorePct === 0 || scorePct >= needed)) {
    return {
      status: "completed",
      evidence: { platform_confirmed: true, score, score_pct: scorePct, min_score_pct: minScorePct },
      checkpoint: { phase: "done" }
    };
  }
  return {
    status: "needs_human",
    reason: `\u9898\u7EC4\u5DF2\u63D0\u4EA4\u4F46\u672A\u8FBE\u5230\u901A\u8FC7\u6761\u4EF6\uFF08score_pct ${scorePct}, min ${minScorePct}\uFF09`,
    evidence: { score, score_pct: scorePct, min_score_pct: minScorePct }
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
