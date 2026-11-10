// src/module.ts
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
var COURSE_LIST_PATH = "/user/student/index";
var COURSE_CATALOG_PATH = "/user/student/mycourse/courseCatalog";
var CATALOG_NAMESPACE = "catalog";
var BROWSER_STUDY = SETTINGS.browser_study !== false;
var UNIT_TEST_ENABLED = SETTINGS.enable_unit_test === true;
var UNIT_TEST_DRY_RUN = SETTINGS.unit_test_dry_run === true;
var ASR_ENABLED = SETTINGS.asr_enabled !== false;
var ASR_PYTHON = typeof SETTINGS.asr_python === "string" && SETTINGS.asr_python.trim() ? SETTINGS.asr_python.trim() : "python";
var ASR_MODEL = typeof SETTINGS.asr_model === "string" && SETTINGS.asr_model.trim() ? SETTINGS.asr_model.trim() : "base.en";
var ASR_TIMEOUT_MS = Number(SETTINGS.asr_timeout_ms ?? 24e3);
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
    const location2 = response2.headers.get("location");
    if (!location2) return { url, response: response2, body: await response2.text() };
    url = new URL(location2, url).toString();
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
    await follow(session, `${UNIPUS_BASE}/logout?school_id=&repeatLogin=1`, 6);
    await follow(session, `${UNIPUS_BASE}/user/comm/login?school_id=`, 4);
  } catch (error) {
    log("warn", `logout other session failed: ${errorText(error)}`);
  }
}
async function casLogin(session, username, password) {
  const service = `${UNIPUS_BASE}/user/comm/login?school_id=`;
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
    if (!resolvedOpenId) {
      lastError = { code: "platform_protocol_changed", message: "getToken \u672A\u8FD4\u56DE openId" };
      continue;
    }
    return { token: String(token), openId: String(resolvedOpenId), displayName: username };
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
function decodeHtml(value) {
  return String(value ?? "").replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return "";
    }
  }).replace(/&#(\d+);/g, (_match, number) => {
    try {
      return String.fromCodePoint(Number(number));
    } catch {
      return "";
    }
  }).replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_match, name) => {
    const key = String(name).toLowerCase();
    return key === "nbsp" ? " " : key === "amp" ? "&" : key === "lt" ? "<" : key === "gt" ? ">" : key === "quot" ? '"' : "'";
  });
}
function stripTags(value) {
  return decodeHtml(String(value ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function parseCourseCards(html) {
  const cards = [];
  const seen = /* @__PURE__ */ new Set();
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const opens = [...body.matchAll(/<div\b[^>]*\bclass\s*=\s*(["'])([^"']*)\1[^>]*>/gi)].filter((match) => /\bmy_course_item\b/.test(match[2] ?? ""));
  for (let index = 0; index < opens.length; index += 1) {
    const start = opens[index].index ?? 0;
    const end = index + 1 < opens.length ? opens[index + 1].index ?? body.length : body.length;
    const chunk = body.slice(start, end);
    if (!/\bite\b/.test(opens[index][2] ?? "") && !/\bhideurl\b/i.test(chunk)) continue;
    let raw = "";
    const hide = chunk.match(
      /<([a-zA-Z][\w-]*)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bhideurl\b[^"']*\2[^>]*>([\s\S]*?)<\/\1>/i
    );
    if (hide) {
      const openTag = hide[0].slice(0, hide[0].indexOf(">") + 1);
      const href = openTag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
      raw = stripTags(hide[3]) || decodeHtml(href?.[2] ?? "");
    }
    if (!raw) {
      const href = chunk.match(
        /\bhref\s*=\s*(["'])([^"']*\/user\/student\/mycourse\/courseCatalog[^"']*)\1/i
      );
      raw = decodeHtml(href?.[2] ?? "");
    }
    if (!raw) continue;
    let url;
    try {
      url = new URL(raw, UNIPUS_BASE);
    } catch {
      continue;
    }
    const host = new URL(UNIPUS_BASE).hostname;
    if (url.hostname !== host || url.pathname !== COURSE_CATALOG_PATH) continue;
    const query = url.searchParams;
    const apiCourseId = String(query.get("courseId") ?? "").trim();
    const classId = String(query.get("classId") ?? "").trim();
    const schoolId = String(query.get("school_id") ?? "").trim();
    const eccId = String(query.get("eccId") ?? "").trim();
    const courseType = String(query.get("coursetype") ?? "").trim();
    if (!/^\d+$/.test(apiCourseId) || !/^\d+$/.test(classId) || classId === "0" || !/^\d+$/.test(eccId) || !/^\d*$/.test(courseType) || schoolId !== "" && !/^\d+$/.test(schoolId)) continue;
    const nameElement = chunk.match(
      /<([a-zA-Z][\w-]*)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bmy_course_name\b[^"']*\2[^>]*>([\s\S]*?)<\/\1>/i
    );
    const title = nameElement ? decodeHtml(nameElement[0].match(/\btitle\s*=\s*(["'])(.*?)\1/i)?.[2] ?? stripTags(nameElement[3])) : "";
    const name = title.trim() || `U\u6821\u56ED\u8BFE\u7A0B ${apiCourseId}`;
    const key = `${apiCourseId}\0${classId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({
      api_course_id: apiCourseId,
      class_id: classId,
      school_id: schoolId,
      ecc_id: eccId,
      course_type: courseType,
      name,
      catalog_url: `${UNIPUS_BASE}${COURSE_CATALOG_PATH}?courseId=${encodeURIComponent(apiCourseId)}&school_id=${encodeURIComponent(schoolId)}&eccId=${encodeURIComponent(eccId)}&classId=${encodeURIComponent(classId)}&coursetype=${encodeURIComponent(courseType)}`
    });
  }
  return cards;
}
function parseCourseShell(html) {
  const read = (names) => {
    for (const name of names) {
      const values = /* @__PURE__ */ new Set();
      const pattern = new RegExp(`\\bvar\\s+${name}\\s*=\\s*(['"])([^'"]*)\\1`, "g");
      for (const match of html.matchAll(pattern)) {
        if (match[2]) values.add(match[2]);
      }
      if (values.size === 1) return [...values][0];
      if (values.size > 1) return "";
    }
    return "";
  };
  return {
    content_id: read(["course_id", "courseId"]),
    version: read(["version"]),
    db_course_id: read(["dbCourseId", "db_course_id", "db_courseid"]),
    class_id: read(["classId", "class_id"])
  };
}
function isLoginHtml(html) {
  return /<title[^>]*>\s*(?:SSO)?登录\s*<\/title>/i.test(html) || /\bid\s*=\s*["']pw-form["']/i.test(html) || /<form[^>]+action\s*=\s*["'][^"']*(?:sso\.unipus\.cn|\/user\/comm\/login)/i.test(html) || /location(?:\.href)?\s*=\s*["'][^"']*(?:sso\.unipus\.cn|\/user\/comm\/login)/i.test(html);
}
function accountKey(openId) {
  return openId || "default";
}
function courseStateKey(openId, apiCourseId, classId) {
  return `course:${accountKey(openId)}:${apiCourseId}:${classId}`;
}
async function readCourseCards(session, openId) {
  const stored = await hostCall("cw.state", {
    session,
    namespace: CATALOG_NAMESPACE,
    key: `courses:${accountKey(openId)}`
  });
  return Array.isArray(stored?.value) ? stored.value : null;
}
async function fetchCourseList(session, auth) {
  const result = await follow(session, `${UNIPUS_BASE}${COURSE_LIST_PATH}`, 8);
  const html = result.body;
  if (isLoginHtml(html)) {
    throw { code: "platform_login_expired", message: "U\u6821\u56ED\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5" };
  }
  if (!result.response.ok && !html.trim()) {
    throw { code: "platform_unavailable", message: `\u8BFE\u7A0B\u5217\u8868 HTTP ${result.response.status}` };
  }
  const cards = parseCourseCards(html);
  if (cards.length === 0) {
    log("warn", "\u8BFE\u7A0B\u5217\u8868\u6CA1\u6709\u89E3\u6790\u5230\u8BFE\u7A0B\uFF0C\u8BF7\u68C0\u67E5\u8D26\u53F7\u662F\u5426\u5DF2\u52A0\u5165\u73ED\u7EA7\u6216\u8BFE\u7A0B\u5217\u8868\u9875\u7ED3\u6784");
  }
  if (!result.response.ok && cards.length === 0) {
    throw { code: "platform_unavailable", message: `\u8BFE\u7A0B\u5217\u8868 HTTP ${result.response.status}` };
  }
  await hostCall("cw.state", {
    session,
    namespace: CATALOG_NAMESPACE,
    key: `courses:${accountKey(String(auth?.open_id ?? ""))}`,
    value: cards
  });
  log("info", `catalog.courses openId=${auth?.open_id ?? ""} courses=${cards.length}`);
  return cards;
}
async function ensureContentSession(session, courseId) {
  const next = encodeURIComponent(`/courses/${courseId}/menus`);
  try {
    await follow(session, `${UCONTENT_BASE}/cas-auth/login/?next=${next}`, 6);
  } catch (error) {
    log("warn", `ucontent session failed: ${errorText(error)}`);
  }
}
async function catalogCourses(params) {
  const session = String(params.session ?? "");
  const auth = await readAuth(session);
  const cards = await fetchCourseList(session, auth);
  return {
    courses: cards.map((card) => ({
      id: card.api_course_id,
      recruit_id: card.class_id,
      name: card.name,
      kind: "shared",
      kind_label: "U\u6821\u56ED\u8BFE\u7A0B",
      family: "shared",
      progress: null,
      outline_available: true
    }))
  };
}
async function resolveCourse(session, publicCourse, auth) {
  const openId = String(auth?.open_id ?? "");
  const wantedId = String(publicCourse?.id ?? "").trim();
  const wantedClass = String(publicCourse?.recruit_id ?? "").trim();
  let cards = await readCourseCards(session, openId);
  const findCard = (values) => {
    const matches = values.filter(
      (card2) => (!wantedId || card2.api_course_id === wantedId) && (!wantedClass || card2.class_id === wantedClass)
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw { code: "invalid_params", message: "\u8BE5\u8BFE\u7A0B\u6709\u591A\u4E2A\u73ED\u7EA7\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u8BFE\u7A0B\u548C\u73ED\u7EA7" };
    }
    return null;
  };
  let card = null;
  if (wantedId || wantedClass) {
    card = findCard(cards ?? []);
    if (!card) {
      cards = await fetchCourseList(session, auth);
      card = findCard(cards);
    }
    if (!card) throw { code: "not_found", message: "\u5F53\u524D\u8D26\u53F7\u4E0B\u627E\u4E0D\u5230\u8FD9\u95E8\u8BFE\u7A0B\uFF0C\u8BF7\u5237\u65B0\u8BFE\u7A0B\u5217\u8868" };
  } else {
    if (!cards) cards = await fetchCourseList(session, auth);
    const selected = await hostCall("cw.state", {
      session,
      namespace: CATALOG_NAMESPACE,
      key: `selected:${accountKey(openId)}`
    });
    const selectedId = String(selected?.value?.id ?? "");
    const selectedClass = String(selected?.value?.recruit_id ?? "");
    if (selectedId || selectedClass) {
      const found = (cards ?? []).find(
        (value) => (!selectedId || value.api_course_id === selectedId) && (!selectedClass || value.class_id === selectedClass)
      );
      if (found) card = found;
    }
    if (!card && (cards ?? []).length === 1) card = cards[0];
    if (!card) throw { code: "invalid_params", message: "\u8BF7\u5148\u5728\u8BFE\u7A0B\u5217\u8868\u91CC\u9009\u62E9\u4E00\u95E8\u8BFE\u7A0B" };
  }
  const key = courseStateKey(openId, card.api_course_id, card.class_id);
  const stored = await hostCall("cw.state", { session, namespace: CATALOG_NAMESPACE, key });
  const cached = stored?.value;
  let context = cached?.content_id && String(cached.open_id ?? "") === openId && String(cached.api_course_id ?? "") === card.api_course_id && String(cached.class_id ?? "") === card.class_id && String(cached.ecc_id ?? "") === card.ecc_id && String(cached.course_type ?? "") === card.course_type ? {
    ...cached,
    ...card,
    content_id: String(cached.content_id),
    version: String(cached.version || "default"),
    open_id: openId
  } : null;
  if (!context) {
    const page = await follow(session, card.catalog_url, 6);
    if (isLoginHtml(page.body)) {
      throw { code: "platform_login_expired", message: "U\u6821\u56ED\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5" };
    }
    if (!page.response.ok) {
      throw { code: "platform_unavailable", message: `\u8BFE\u7A0B\u76EE\u5F55\u9875 HTTP ${page.response.status}` };
    }
    const shell = parseCourseShell(page.body);
    if (!shell.content_id) {
      throw { code: "platform_protocol_changed", message: "\u8BFE\u7A0B\u76EE\u5F55\u9875\u91CC\u6CA1\u6709\u627E\u5230 course_id" };
    }
    if (shell.db_course_id && shell.db_course_id !== card.api_course_id) {
      throw { code: "platform_protocol_changed", message: "\u8BFE\u7A0B\u76EE\u5F55\u9875\u4E0E\u8BFE\u7A0B\u5217\u8868\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u5237\u65B0\u8BFE\u7A0B\u5217\u8868" };
    }
    if (shell.class_id && shell.class_id !== card.class_id) {
      throw { code: "platform_protocol_changed", message: "\u8BFE\u7A0B\u76EE\u5F55\u9875\u4E0E\u6240\u9009\u73ED\u7EA7\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9" };
    }
    context = {
      ...card,
      content_id: shell.content_id,
      version: shell.version || "default",
      open_id: openId
    };
    await hostCall("cw.state", { session, namespace: CATALOG_NAMESPACE, key, value: context });
    log("info", `course resolved ${card.api_course_id}/${card.class_id} -> ${context.content_id}`);
  }
  await hostCall("cw.state", {
    session,
    namespace: CATALOG_NAMESPACE,
    key: `selected:${accountKey(openId)}`,
    value: { id: card.api_course_id, recruit_id: card.class_id, at: Date.now() }
  });
  return context;
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
  const course = await resolveCourse(session, params.course, auth);
  const courseId = course.content_id;
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
    const walk = (node, parentId, grandId) => {
      if (node?.role === "link" && node.url) {
        let exam = null;
        try {
          exam = JSON.parse(String(node.summary ?? ""));
        } catch {
        }
        if (exam && (exam.exerciseId || exam.examId)) {
          const pass = Number(leafs?.[node.url]?.state?.pass ?? 0);
          units.push({
            id: `${node.url}::quiz-paper-link`,
            name: String(node.name ?? node.url).trim(),
            chapter_id: unitId,
            chapter_name: `${String(unit.caption ?? "").trim()} ${String(unit.name ?? "").trim()}`.trim(),
            lesson_id: parentId,
            kind: "document",
            duration_seconds: 0,
            watched_seconds: 0,
            state: pass === 1 ? "completed" : "not_started",
            video_id: null,
            selectable: true,
            selectable_note: "quiz-paper-link",
            courseware_path: grandId && grandId !== unitId ? [unitId, grandId, parentId, String(node.url)] : null,
            exam: {
              exercise_id: String(exam.exerciseId ?? ""),
              exam_id: String(exam.examId ?? ""),
              question_number: String(exam.questionNumber ?? ""),
              total_score: String(exam.totalScore ?? ""),
              type: String(exam.type ?? "")
            }
          });
        }
        return;
      }
      if (node?.role === "group" && node.url) {
        const tab = String(node.tab_type ?? "");
        const base = String(node.base ?? "");
        if (tab !== "text" && tab !== "video" && tab !== "task") {
          for (const child of node.children ?? []) walk(child, String(node.url), parentId);
          return;
        }
        if (base === "quiz-paper-link") {
          for (const child of node.children ?? []) walk(child, String(node.url), parentId);
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
      const nodeUrl = String(node?.url ?? "");
      const nextParent = nodeUrl || parentId;
      const nextGrand = nodeUrl ? parentId : grandId;
      for (const child of node?.children ?? []) walk(child, nextParent, nextGrand);
    };
    for (const child of unit.children ?? []) walk(child, unitId, unitId);
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
async function solveChoiceQuestions(session, group, context = "") {
  const questions = (group.questions ?? []).map((question, index) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html),
    options: (question?.options ?? []).map((option) => ({
      caption: String(option?.caption ?? ""),
      text: stripHtml(option?.content?.html)
    }))
  }));
  if (questions.length === 0) return null;
  const contextBlock = context.trim() ? `\u542C\u529B/\u89C6\u9891\u539F\u6587\uFF1A
${context.trim()}
` : "";
  const prompt = [
    "\u4F60\u662F U\u6821\u56ED\u82F1\u8BED\u7EC3\u4E60\u7B54\u9898\u52A9\u624B\u3002",
    "\u6839\u636E\u542C\u529B/\u89C6\u9891\u539F\u6587\u548C\u9898\u76EE\u9009\u62E9\u6B63\u786E\u7B54\u6848\uFF1B\u539F\u6587\u6CA1\u6709\u8986\u76D6\u7684\u4FE1\u606F\u4E0D\u8981\u7F16\u9020\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["\u7B54\u6848"]}\u3002',
    "\u9009\u62E9\u9898 texts \u8FD4\u56DE\u6B63\u786E\u9009\u9879\u7684 caption\uFF08A/B/C/D\uFF09\uFF0C\u5982\u679C\u4E0D\u786E\u5B9A caption\uFF0C\u8FD4\u56DE\u9009\u9879\u539F\u6587\u3002",
    contextBlock,
    JSON.stringify(questions)
  ].join("\n");
  if (context.trim()) log("info", `choice context ${context.trim().length} chars`);
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
async function askAiForItems(session, prompt) {
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
  return Array.isArray(parsed) ? parsed : null;
}
function answerMapFromItems(items) {
  if (!items) return null;
  const out = {};
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id ?? "");
    const texts = Array.isArray(item.texts) ? item.texts.map(String) : Array.isArray(item.answers) ? item.answers.map(String) : [];
    if (id) out[id] = texts;
  }
  return out;
}
async function solveSequenceQuestions(session, group, context = "") {
  const questions = (group.questions ?? []).map((question, index) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html)
  }));
  const options = (group.options ?? []).map((option) => ({
    caption: String(option?.caption ?? ""),
    text: stripHtml(option?.content?.html)
  }));
  if (questions.length === 0 || options.length === 0) return null;
  const prompt = [
    "\u4F60\u662F U\u6821\u56ED\u82F1\u8BED\u7EC3\u4E60\u7B54\u9898\u52A9\u624B\u3002",
    "\u8FD9\u662F\u6392\u5E8F/\u5339\u914D\u9898\u3002\u9898\u76EE\u4E2D\u7684\u56FE\u7247\u6216\u7A7A\u683C\u6309\u987A\u5E8F\u5BF9\u5E94\u542C\u529B\u539F\u6587\u4E2D\u7684\u4EBA\u7269\u6216\u6BB5\u843D\u3002",
    "\u8BF7\u6839\u636E\u539F\u6587\uFF0C\u628A\u6BCF\u4E2A\u9898\u76EE\u5339\u914D\u5230\u6B63\u786E\u9009\u9879\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["A"]}\uFF0Ctexts \u53EA\u653E\u4E00\u4E2A\u9009\u9879 caption\u3002',
    context.trim() ? `\u542C\u529B/\u89C6\u9891\u539F\u6587\uFF1A
${context.trim()}` : "",
    `\u9009\u9879\uFF1A${JSON.stringify(options)}`,
    JSON.stringify(questions)
  ].join("\n");
  return answerMapFromItems(await askAiForItems(session, prompt));
}
async function solveMultiChoiceQuestions(session, group, context = "") {
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
    "\u8FD9\u662F\u591A\u9009\u9898\uFF0C\u6BCF\u9053\u9898\u53EF\u80FD\u6709\u591A\u4E2A\u6B63\u786E\u9009\u9879\u3002",
    "\u6839\u636E\u542C\u529B/\u89C6\u9891\u539F\u6587\u548C\u9898\u76EE\uFF0C\u9009\u51FA\u6240\u6709\u6B63\u786E\u9009\u9879\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["A","C"]}\u3002',
    context.trim() ? `\u542C\u529B/\u89C6\u9891\u539F\u6587\uFF1A
${context.trim()}` : "",
    JSON.stringify(questions)
  ].join("\n");
  return answerMapFromItems(await askAiForItems(session, prompt));
}
function parseVtt(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line) || /^NOTE\b/i.test(line) || /^\d+$/.test(line) || line.includes("-->")) continue;
    const clean = stripHtml(line.replace(/<[^>]+>/g, " "));
    if (!clean) continue;
    if (out[out.length - 1] === clean) continue;
    out.push(clean);
  }
  return out.join(" ");
}
var asrCache = /* @__PURE__ */ new Map();
async function transcribeAudio(session, audioUrl) {
  if (!ASR_ENABLED) return "";
  const url = audioUrl.replace(/#.*$/, "");
  if (asrCache.has(url)) return asrCache.get(url) ?? "";
  let binary = null;
  try {
    binary = await hostCall("cw.net.fetch", {
      session,
      method: "GET",
      url,
      headers: { ...BROWSER_HEADERS, accept: "*/*" },
      stage: "read",
      binary: true
    });
  } catch (error) {
    log("warn", `asr download failed: ${errorText(error)}`);
    return "";
  }
  if (!binary?.body) return "";
  const base64 = String(binary.body);
  try {
    const result = await hostCall("cw.asr.transcribe", {
      session,
      audio: base64,
      mime: "audio/mpeg"
    });
    const text = String(result?.text ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      asrCache.set(url, text);
      log("info", `asr(host) ${url.slice(-48)} -> ${text.length} chars`);
      return text;
    }
  } catch (error) {
    log("warn", `host asr unavailable: ${errorText(error)}`);
  }
  let dir = "";
  const scriptPath = fileURLToPath(new URL("./scripts/transcribe_audio.py", import.meta.url));
  try {
    dir = mkdtempSync(join(tmpdir(), "courseflow-asr-"));
    const audioPath = join(dir, "audio.mp3");
    writeFileSync(audioPath, Buffer.from(base64, "base64"));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(ASR_PYTHON, [scriptPath, audioPath, ASR_MODEL], {
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          HF_ENDPOINT: process.env.HF_ENDPOINT || process.env.CF_ASR_HF_ENDPOINT || "https://hf-mirror.com"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`ASR timeout ${ASR_TIMEOUT_MS}ms`));
      }, ASR_TIMEOUT_MS);
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`ASR exit ${code}: ${stderr.slice(-300)}`));
      });
    });
    const parsed = JSON.parse(output.trim());
    const text = String(parsed?.text ?? "").trim();
    if (text) {
      asrCache.set(url, text);
      log("info", `asr ${url.slice(-48)} -> ${text.length} chars`);
    }
    return text;
  } catch (error) {
    log("warn", `asr failed: ${errorText(error)}`);
    return "";
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
async function collectStudyContext(session, decoded) {
  const parts = [];
  const seenVtt = /* @__PURE__ */ new Set();
  const seenAsr = /* @__PURE__ */ new Set();
  if (!decoded || typeof decoded !== "object") return "";
  for (const group of Object.values(decoded)) {
    for (const content of group?.content ?? []) {
      const script = content?.audio?.script;
      const scriptHtml = typeof script === "string" ? script : script?.html;
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
      if (typeof videoFile === "string" && /\.vtt(?:\?|#|$)/i.test(videoFile) && !seenVtt.has(videoFile)) {
        seenVtt.add(videoFile);
        try {
          const { text } = await fetchText(session, videoFile, { accept: "*/*" }, "read");
          const parsed = parseVtt(text);
          if (parsed) parts.push(parsed);
        } catch (error) {
          log("warn", `vtt ${videoFile} failed: ${errorText(error)}`);
        }
      }
      const audioUrl = content?.audio?.audio?.url;
      if (!scriptHtml && !videoFile && typeof audioUrl === "string" && audioUrl && !seenAsr.has(audioUrl)) {
        seenAsr.add(audioUrl);
        const text = await transcribeAudio(session, audioUrl);
        if (text) parts.push(text);
      }
    }
  }
  const unique = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of parts) {
    const text = part.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  return unique.join("\n\n").slice(0, 16e3);
}
function findQuestionGroup(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  const groups = Object.values(decoded).filter(
    (value) => value && Array.isArray(value.questions)
  );
  if (groups.length === 0) return null;
  if (groups.length === 1) return groups[0];
  return {
    ...groups[0],
    questions: groups.flatMap((group) => group.questions ?? [])
  };
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
async function solveTextQuestions(session, group, context = "") {
  const questions = (group.questions ?? []).map((question, index) => ({
    id: String(index),
    stem: stripHtml(question?.content?.html)
  }));
  if (questions.length === 0) return null;
  const prompt = [
    "\u4F60\u662F U\u6821\u56ED\u82F1\u8BED\u7EC3\u4E60\u7B54\u9898\u52A9\u624B\u3002",
    '\u53EA\u8F93\u51FA JSON \u6570\u7EC4\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\u6BCF\u9879\u683C\u5F0F {"id":"\u9898\u76EEid","texts":["\u7B54\u6848"]}\u3002',
    "\u7B80\u7B54\u9898/\u586B\u7A7A\u9898\u7ED9\u51FA\u7B80\u77ED\u3001\u76F4\u63A5\u3001\u7B26\u5408\u9898\u610F\u7684\u82F1\u6587\u7B54\u6848\u3002",
    "\u539F\u6587\u91CC\u7684 ____1____\u3001____2____ \u662F\u5F85\u586B\u7A7A\u4F4D\uFF0C\u9898\u76EE id \u5BF9\u5E94\u7A7A\u4F4D\u7F16\u53F7\uFF0C\u6309\u7F16\u53F7\u586B\u5199\u3002",
    context.trim() ? `\u542C\u529B/\u89C6\u9891\u539F\u6587\uFF1A
${context.trim()}` : "",
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
function coursewareUrl(courseId, groupId, questionsList, course) {
  const parentPath = questionsList?.[0]?.path?.[1] ?? [];
  const coursewarePath = [...parentPath, groupId];
  const school = course.school_id ? `&schId=${encodeURIComponent(course.school_id)}` : "";
  return `${UCONTENT_BASE}/_pc_default/pc.html?cid=${encodeURIComponent(course.class_id)}&appid=5${school}#/${courseId}/courseware/${coursewarePath.join("/")}/p_1`;
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
async function studyFillblankBrowser(session, course, groupId, decoded, questionGroup, questionsList, auth, minScorePct) {
  const courseId = course.content_id;
  let answers = scriptAnswers(decoded);
  if (answers.length === 0) {
    const context = await collectStudyContext(session, decoded);
    const solved = await solveTextQuestions(session, questionGroup, context);
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
    coursewareUrl(courseId, groupId, questionsList, course),
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
async function studyChoiceBrowser(session, course, groupId, decoded, questionGroup, questionsList, auth, minScorePct) {
  const courseId = course.content_id;
  const context = await collectStudyContext(session, decoded);
  const solved = await solveChoiceQuestions(session, questionGroup, context);
  if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u9009\u62E9\u9898\u7B54\u6848" };
  const captions = choiceCaptions(questionGroup, solved);
  const result = await browserStudy(
    session,
    courseId,
    groupId,
    coursewareUrl(courseId, groupId, questionsList, course),
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
  const category = String(questionGroup.category ?? "").toLowerCase();
  const isFill = /fillblank/.test(category);
  const isSequence = category === "sequence";
  const isMulti = category === "multichoice";
  const choice = !isFill && !isSequence && !isMulti ? { group: questionGroup, category } : null;
  const questions = questionGroup.questions ?? [];
  let values = precomputedValues ?? [];
  if (isFill) {
    if (values.length === 0) values = scriptAnswers(decoded);
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveTextQuestions(session, questionGroup, context);
      if (!solved) return { status: "needs_human", reason: "fillblankScoop \u6CA1\u6709\u7B54\u6848\u6765\u6E90" };
      values = questions.map((_, index) => solved[String(index)]?.[0] ?? "");
    }
  } else if (isSequence) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveSequenceQuestions(session, questionGroup, context);
      if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u6392\u5E8F\u9898\u7B54\u6848" };
      values = questions.map((_, index) => solved[String(index)]?.[0] ?? "");
    }
  } else if (isMulti) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveMultiChoiceQuestions(session, questionGroup, context);
      if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u591A\u9009\u9898\u7B54\u6848" };
      values = questions.map((_, index) => solved[String(index)] ?? []);
    }
  } else if (choice) {
    if (values.length === 0) {
      const context = await collectStudyContext(session, decoded);
      const solved = await solveChoiceQuestions(session, choice.group, context);
      if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u9009\u62E9\u9898\u7B54\u6848" };
      values = choiceCaptions(choice.group, solved);
    }
  } else {
    return { status: "needs_human", reason: `\u672A\u652F\u6301\u7684\u5BA2\u89C2\u9898\u7C7B\u578B ${category || "unknown"}` };
  }
  if (values.length === 0) return { status: "needs_human", reason: "\u6CA1\u6709\u6784\u9020\u51FA\u7B54\u6848" };
  const userState = await fetchUserState(session, courseId, groupId, auth);
  const version = String(
    userState?.state?.version ?? userState?.version ?? Math.floor(Date.now() / 1e3)
  );
  const firstQid = collectQids(indexMap)[0];
  if (!firstQid) return { status: "needs_human", reason: "\u9898\u7EC4\u6CA1\u6709\u8FD4\u56DE qid" };
  const multiPage = !isSinglePageTask(questionsList);
  const pages = {};
  const answerList = {};
  const answers = {};
  for (let index = 0; index < questions.length; index += 1) {
    const path = questionsList[index]?.path?.[0] ?? [];
    const pageId = String(path[1] ?? "p_1");
    const meta = pageMeta(indexMap, pageId);
    const qid = meta.qid ?? firstQid;
    const defaultRule = isFill ? "in" : isSequence ? "eq_ig_case" : isMulti ? "contain" : "eq";
    const rule = String(
      (Array.isArray(meta.rules) ? meta.rules[index] ?? meta.rules[0] : meta.rules) ?? defaultRule
    );
    const rawValue = values[index];
    const value = isMulti ? Array.isArray(rawValue) ? rawValue.map(String) : rawValue ? [String(rawValue)] : [] : String(rawValue ?? "");
    const slicedPage = multiPage && !isSequence && !isMulti;
    const answerIndex = slicedPage ? 0 : index;
    const offset = slicedPage ? index : 0;
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
        answer: { index: answerIndex, answer: value, version: "v2" },
        content: "",
        id: `${qid}-${answerIndex}`,
        offset
      }
    };
    const existingComponent = userState?.state?.[pageId] ? Object.keys(userState.state[pageId])[0] : "";
    const component = existingComponent || (isSequence ? "c_1_0" : "c_1_1");
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
function isShortAnswerTask(category, decoded) {
  if (category === "shortanswerscoop") return true;
  const keys = Object.keys(decoded ?? {});
  return keys.some((key) => key === "shortanswer:shortanswer" || key === "questions:shortanswer");
}
function isOralTask(decoded) {
  const keys = Object.keys(decoded ?? {});
  return keys.some(
    (key) => /^(roleplay|presentation):/.test(key) || /sentencesforrecord|individualpresentation-course/i.test(key)
  );
}
async function studyShortAnswerApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct) {
  const category = String(questionGroup.category ?? "").toLowerCase();
  const questions = questionGroup.questions ?? [];
  if (questions.length === 0) return { status: "needs_human", reason: "\u77ED\u7B54\u9898\u6CA1\u6709\u9898\u76EE" };
  const context = await collectStudyContext(session, decoded);
  const solved = await solveTextQuestions(session, questionGroup, context);
  if (!solved) return { status: "needs_human", reason: "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u53EF\u7528\u7684\u77ED\u7B54\u9898\u7B54\u6848" };
  const values = questions.map((_, index) => solved[String(index)]?.[0] ?? "");
  if (values.every((value) => !value.trim())) {
    return { status: "needs_human", reason: "\u77ED\u7B54\u9898\u6CA1\u6709\u751F\u6210\u6709\u6548\u7B54\u6848" };
  }
  const userState = await fetchUserState(session, courseId, groupId, auth);
  const version = String(
    userState?.state?.version ?? userState?.version ?? Math.floor(Date.now() / 1e3)
  );
  const firstQid = collectQids(indexMap)[0];
  if (!firstQid) return { status: "needs_human", reason: "\u9898\u7EC4\u6CA1\u6709\u8FD4\u56DE qid" };
  const pageId = String(questionsList?.[0]?.path?.[0]?.[1] ?? "p_1");
  const meta = pageMeta(indexMap, pageId);
  const qid = meta.qid ?? firstQid;
  const keys = Object.keys(decoded ?? {});
  const component = category === "shortanswerscoop" || keys.some((key) => /^shortanswer:/.test(key)) ? "c_1_1" : "c_1_0";
  const studentAnswers = {};
  const answerList = {};
  const answers = {};
  for (let index = 0; index < questions.length; index += 1) {
    const value = values[index] ?? "";
    studentAnswers[String(index)] = value;
    answerList[String(index)] = {
      student_answer: value,
      isDone: true,
      version: "v2",
      rule: "subjective"
    };
    answers[String(index)] = {
      student_answer: value,
      isDone: true,
      version: "v2",
      rule: "subjective"
    };
  }
  const stateObj = {
    version,
    [pageId]: { [component]: { student_answers: studentAnswers } },
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
  log("info", `submit shortanswer ${groupId} HTTP ${submit.status} code ${submitJson?.code ?? "?"}`);
  if (submitJson?.code !== 0) {
    return {
      status: "needs_human",
      reason: `\u77ED\u7B54\u9898\u63D0\u4EA4\u5931\u8D25\uFF1Acode ${submitJson?.code ?? "?"} ${submitJson?.msg ?? submit.body.slice(0, 160)}`
    };
  }
  const info = submitJson?.data?.submit_info;
  const submitState = Number(info?.state?.state ?? 0);
  const scorePct = Number(info?.state?.real_score_pct ?? info?.state?.score_pct ?? 0);
  if (submitState === 1 && (minScorePct === 0 || scorePct >= minScorePct)) {
    return {
      status: "completed",
      evidence: { platform_confirmed: true, subjective: true, score_pct: scorePct },
      checkpoint: { phase: "done" }
    };
  }
  return {
    status: "needs_human",
    reason: `\u77ED\u7B54\u9898\u5DF2\u63D0\u4EA4\u4F46\u5E73\u53F0\u672A\u786E\u8BA4\uFF08state ${submitState}, score_pct ${scorePct}\uFF09`,
    evidence: { state: submitState, score_pct: scorePct }
  };
}
function paperCoursewareUrl(course, unit) {
  const path = Array.isArray(unit?.courseware_path) ? unit.courseware_path.map((item) => String(item ?? "")).filter(Boolean) : [];
  if (path.length < 2) return null;
  const school = course.school_id ? `&schId=${encodeURIComponent(course.school_id)}` : "";
  return `${UCONTENT_BASE}/_pc_default/pc.html?cid=${encodeURIComponent(course.class_id)}&appid=5${school}&appName=3001#/${course.content_id}/courseware/${path.join("/")}/p_1`;
}
function stripOptionPrefix(value) {
  return String(value ?? "").replace(/^[A-Da-d][.、)]\s*/, "").trim();
}
function normalizeAnswer(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function matchPaperOption(raw, options) {
  const wanted = normalizeAnswer(raw);
  if (!wanted) return null;
  const letter = wanted.match(/^\(?([a-d])\)?(?:[.\s]|$)/);
  if (letter) {
    const position = letter[1].charCodeAt(0) - 97;
    if (options[position]) return options[position];
  }
  for (const option of options) {
    const text = normalizeAnswer(stripOptionPrefix(option.text));
    if (!text) continue;
    if (text === wanted || wanted.includes(text) || text.includes(wanted)) return option;
  }
  let best = null;
  let bestScore = 0;
  for (const option of options) {
    const text = normalizeAnswer(stripOptionPrefix(option.text));
    const tokens = text.split(/[^a-z0-9']+/).filter((token) => token.length > 2);
    const score = tokens.filter((token) => wanted.includes(token)).length / Math.max(1, tokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return bestScore >= 0.5 ? best : null;
}
function tokenizeSpoken(text) {
  return String(text ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).map((raw) => ({ raw, norm: raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") }));
}
function alignPaperBlanks(sectionText, transcript, indexes) {
  const wanted = new Set(indexes.map(String));
  const template = tokenizeSpoken(sectionText).map((token) => {
    const marker = token.raw.match(/^(\d{1,2})\)/);
    return { ...token, blank: marker && wanted.has(marker[1]) ? marker[1] : null };
  });
  const spoken = tokenizeSpoken(transcript);
  const n = template.length;
  const m = spoken.length;
  const answers = {};
  if (!n || !m) return answers;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i2 = 1; i2 <= n; i2 += 1) {
    for (let j2 = 1; j2 <= m; j2 += 1) {
      dp[i2][j2] = template[i2 - 1].norm && template[i2 - 1].norm === spoken[j2 - 1].norm ? dp[i2 - 1][j2 - 1] + 1 : Math.max(dp[i2 - 1][j2], dp[i2][j2 - 1]);
    }
  }
  const aligned = new Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (template[i - 1].norm && template[i - 1].norm === spoken[j - 1].norm && dp[i][j] === dp[i - 1][j - 1] + 1) {
      aligned[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  for (let k = 0; k < n; k += 1) {
    const marker = template[k].blank;
    if (!marker) continue;
    let before = -1;
    let after = -1;
    for (let x = k - 1; x >= 0; x -= 1) {
      if (aligned[x] >= 0) {
        before = aligned[x];
        break;
      }
    }
    for (let x = k + 1; x < n; x += 1) {
      if (aligned[x] >= 0) {
        after = aligned[x];
        break;
      }
    }
    if (before < 0 || after <= before + 1) continue;
    const words = spoken.slice(before + 1, after).map((token) => token.raw).filter((word) => /[a-z0-9]/i.test(word));
    if (!words.length || words.length > 8) continue;
    answers[marker] = words.join(" ").replace(/^[,;:.\-]+|[,;:.\-]+$/g, "");
  }
  return answers;
}
function parsePaperAudio(value) {
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && /^https?:/.test(item)).filter((item) => !/question_num\.mp3$/i.test(item));
    }
  } catch {
  }
  const text = String(value ?? "");
  return /^https?:/.test(text) && !/question_num\.mp3$/i.test(text) ? [text] : [];
}
async function paperTranscripts(session, sections) {
  const map = /* @__PURE__ */ new Map();
  const urls = [];
  for (const section of sections ?? []) {
    for (const value of section.audio ?? []) urls.push(...parsePaperAudio(value));
    for (const set of section.questions ?? []) {
      for (const value of set.audio ?? []) urls.push(...parsePaperAudio(value));
    }
  }
  for (const url of [...new Set(urls)]) {
    if (!url) continue;
    map.set(url, await transcribeAudio(session, url) || "");
  }
  return map;
}
function sectionTranscript(section, transcripts) {
  const own = (section?.audio ?? []).flatMap((value) => parsePaperAudio(value)).map((url) => transcripts.get(url) ?? "").filter(Boolean).join(" ");
  if (own) return own;
  const nested = (section?.questions ?? []).flatMap((set) => set.audio ?? []).flatMap((value) => parsePaperAudio(value)).map((url) => transcripts.get(url) ?? "").filter(Boolean).join(" ");
  if (nested) return nested;
  return [...transcripts.values()].filter(Boolean).join(" ");
}
async function askAiJson(session, prompt) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await hostCall("cw.ai.generate", {
      session,
      prompt: attempt === 0 ? prompt : `${prompt}
\u4E0A\u6B21\u8F93\u51FA\u4E0D\u662F\u5408\u6CD5 JSON\uFF1B\u8FD9\u6B21\u53EA\u8F93\u51FA JSON\u3002`
    });
    const raw = String(response?.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    try {
      if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
      return JSON.parse(raw);
    } catch {
    }
  }
  return null;
}
async function solvePaperAnswers(session, details) {
  const transcripts = await paperTranscripts(session, details.sections ?? []);
  const answers = {};
  const missingBlank = [];
  for (const section of details.sections ?? []) {
    const blankIndexes = (section.questions ?? []).flatMap((set) => set.indexes ?? []).map(String).filter((index) => {
      const question = (details.questions ?? []).find((item) => String(item.index) === index);
      return question && question.type !== "radio";
    });
    if (!blankIndexes.length) continue;
    const transcript = sectionTranscript(section, transcripts);
    if (!transcript) {
      missingBlank.push(...blankIndexes);
      continue;
    }
    const blanks = alignPaperBlanks(String(section.text ?? ""), transcript, blankIndexes);
    for (const [index, value] of Object.entries(blanks)) {
      if (value) answers[index] = value;
    }
    for (const index of blankIndexes) if (!answers[index]) missingBlank.push(index);
  }
  for (const index of missingBlank) {
    const question = (details.questions ?? []).find((item) => String(item.index) === index);
    if (!question) continue;
    const section = (details.sections ?? []).find(
      (item) => (item.questions ?? []).some((set) => (set.indexes ?? []).includes(index))
    );
    const result = await askAiJson(session, [
      "\u4F60\u662F U\u6821\u56ED\u590D\u5408\u5F0F\u542C\u5199\u7B54\u9898\u52A9\u624B\u3002",
      `\u7A7A\u53F7\uFF1A${index}`,
      "\u8BD5\u5377\u6BB5\u843D\uFF08\u6570\u5B57\u662F\u7A7A\u53F7\uFF09\uFF1A",
      String(section?.text ?? "").slice(0, 6e3),
      "\u542C\u529B\u539F\u6587\uFF1A",
      sectionTranscript(section, transcripts).slice(0, 6e3),
      "\u53EA\u586B\u8BE5\u7A7A\u5BF9\u5E94\u7684\u539F\u8BCD\uFF0C\u5FC5\u987B\u4E0E\u542C\u529B\u539F\u6587\u7528\u8BCD\u4E00\u81F4\uFF0C\u4E0D\u8981\u6539\u5199\u3002",
      '\u53EA\u8F93\u51FA JSON\uFF1A{"answer":"word"}'
    ].join("\n")).catch(() => null);
    const value = result?.answer ?? Object.values(result ?? {})[0];
    if (value !== void 0 && value !== null && String(value).trim()) {
      answers[index] = String(value).trim();
    }
  }
  for (const question of details.questions ?? []) {
    if (question.type !== "radio") continue;
    const section = (details.sections ?? []).find(
      (item) => (item.questions ?? []).some((set) => (set.indexes ?? []).includes(question.index))
    );
    const transcript = sectionTranscript(section, transcripts);
    const options = question.options ?? [];
    const prompt = [
      "\u4F60\u662F U\u6821\u56ED\u542C\u529B\u6D4B\u8BD5\u7B54\u9898\u52A9\u624B\u3002\u4E0B\u9762\u662F\u4E00\u9053\u542C\u529B\u9009\u62E9\u9898\u3002",
      "\u542C\u529B\u539F\u6587\uFF08\u672B\u5C3E Q: \u662F\u9898\u76EE\uFF09\uFF1A",
      transcript,
      "\u9009\u9879\uFF1A",
      ...options.map((option) => `- ${stripOptionPrefix(option.text)}`),
      "\u5148\u5B9A\u4F4D\u539F\u6587\u4F9D\u636E\uFF0C\u518D\u9009\u6700\u7B26\u5408\u7684\u4E00\u9879\u3002",
      '\u53EA\u8F93\u51FA JSON\uFF1A{"answer":"\u6240\u9009\u9009\u9879\u7684\u5B8C\u6574\u539F\u6587"}'
    ].join("\n");
    try {
      const result = await askAiJson(session, prompt);
      const raw = result?.answer ?? result?.[question.index] ?? Object.values(result ?? {})[0];
      const matched = matchPaperOption(raw, options);
      if (matched) answers[question.index] = stripOptionPrefix(matched.text);
      else if (raw !== void 0 && raw !== null && String(raw).trim()) {
        answers[question.index] = String(Array.isArray(raw) ? raw[0] : raw).trim();
      }
    } catch (error) {
      log("warn", `paper question ${question.index}: ${errorText(error)}`);
    }
  }
  return answers;
}
async function openUnitTestPage() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => Boolean(node && node.offsetParent !== null);
  const clickText = (text) => {
    const target = Array.from(document.querySelectorAll("button, span, div, a")).find((node) => node.children.length === 0 && visible(node) && (node.textContent || "").trim() === text);
    if (!target) return false;
    target.click();
    return true;
  };
  for (let i = 0; i < 8; i += 1) {
    if (!clickText("\u6211\u77E5\u9053\u4E86") && !clickText("\u786E\u5B9A")) break;
    await sleep(400);
  }
  const findStart = () => Array.from(document.querySelectorAll("button")).find((node) => visible(node) && /开始做题|继续答题|开始考试|继续考试/.test(node.innerText || ""));
  let button = findStart();
  const startedAt = Date.now();
  while (!button && Date.now() - startedAt < 12e3) {
    await sleep(500);
    button = findStart();
  }
  if (!button) {
    return { ok: false, error: "no_start_button", text: (document.body?.innerText || "").slice(0, 200) };
  }
  let triggered = false;
  const key = Object.keys(button).find((name) => name.startsWith("__react"));
  let element = key ? button[key]?._currentElement : null;
  for (let i = 0; i < 8 && element; i += 1) {
    const instance = element._owner?._instance;
    if (instance?.todoSubject) {
      instance.todoSubject({ stopPropagation() {
      } });
      triggered = true;
      break;
    }
    element = element._owner?._currentElement ?? null;
  }
  if (!triggered) button.click();
  let src = "";
  const waited = Date.now();
  while (Date.now() - waited < 12e3) {
    const iframe = document.querySelector("#iframe");
    src = String(iframe?.src ?? "");
    if (src) break;
    await sleep(500);
  }
  if (src.startsWith("//")) src = `https:${src}`;
  return { ok: Boolean(src), src };
}
function readUnitTestPaper() {
  const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
  const groups = /* @__PURE__ */ new Map();
  for (const input of Array.from(document.querySelectorAll('input[type="radio"]'))) {
    const index = String(input.getAttribute("qIndex") ?? "");
    if (!index) continue;
    if (!groups.has(index)) groups.set(index, { index, type: "radio", options: [] });
    const label = input.closest("label");
    groups.get(index).options.push({
      value: String(input.value),
      text: clean(label?.innerText)
    });
  }
  for (const input of Array.from(document.querySelectorAll('input[type="text"], textarea'))) {
    const index = String(input.getAttribute("qIndex") ?? "");
    if (!index) continue;
    groups.set(index, { index, type: input.tagName === "TEXTAREA" ? "textarea" : "text" });
  }
  const questions = [...groups.values()].sort((a, b) => Number(a.index) - Number(b.index));
  const sections = Array.from(document.querySelectorAll(".itest-section")).map((section) => {
    const sets = Array.from(section.querySelectorAll(".itest-ques-set")).map((set) => ({
      indexes: [...new Set(Array.from(set.querySelectorAll('input[type="radio"], input[type="text"], textarea')).map((input) => input.getAttribute("qIndex")).filter(Boolean))],
      audio: Array.from(set.querySelectorAll(".itest-hear-reslist span")).map((node) => (node.textContent || "").trim()).filter(Boolean)
    }));
    return {
      title: clean(section.querySelector(".title")?.innerText),
      text: clean(section.innerText).slice(0, 6e3),
      audio: Array.from(section.querySelectorAll(".itest-hear-reslist span")).map((node) => (node.textContent || "").trim()).filter(Boolean),
      questions: sets
    };
  });
  return {
    url: location.href,
    title: document.title,
    loading: location.href === "about:blank",
    ready: Boolean(document.querySelector("#submitAnswerForm, .itest-section")),
    count: questions.length,
    body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    questions,
    sections
  };
}
function fillUnitTestPaper(answerMap) {
  const result = { radio: 0, text: 0, missing: [] };
  for (const [index, value] of Object.entries(answerMap)) {
    const radios = Array.from(document.querySelectorAll(`input[type="radio"][qIndex="${index}"]`));
    if (radios.length) {
      const wanted = String(value);
      let target = radios.find((input2) => {
        const label = input2.closest("label");
        const text = (label?.innerText || "").replace(/\s+/g, " ").trim();
        return text.toLowerCase().includes(wanted.toLowerCase());
      });
      if (!target && /^[A-Da-d]$/.test(wanted)) {
        target = radios.find((input2) => String(input2.value).toUpperCase() === wanted.toUpperCase());
      }
      if (target) {
        (target.closest("label") ?? target).click();
        result.radio += 1;
      } else {
        result.missing.push(index);
      }
      continue;
    }
    const input = document.querySelector(
      `input[type="text"][qIndex="${index}"], textarea[qIndex="${index}"]`
    );
    if (!input) {
      result.missing.push(index);
      continue;
    }
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    result.text += 1;
  }
  return result;
}
async function submitUnitTestPaper() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clickText = (text2) => {
    const target = Array.from(document.querySelectorAll(".layui-layer-btn0, .layui-layer-btn a, button, span")).find((node) => node.offsetParent !== null && (node.textContent || "").trim() === text2);
    if (!target) return false;
    target.click();
    return true;
  };
  for (let i = 0; i < 6; i += 1) {
    if (!clickText("\u6211\u77E5\u9053\u4E86") && !clickText("\u786E\u5B9A")) break;
    await sleep(400);
  }
  const submit = document.querySelector("#submit-answer");
  let submitted = false;
  if (typeof window.paperSubmit === "function") {
    window.paperSubmit(1);
    submitted = true;
  } else if (submit) {
    submit.click();
    submitted = true;
  } else {
    const button = Array.from(document.querySelectorAll("button")).find((node) => node.offsetParent !== null && (node.textContent || "").trim() === "\u63D0\u4EA4");
    if (button) {
      button.click();
      submitted = true;
    }
  }
  let confirmed = false;
  for (let i = 0; i < 10; i += 1) {
    await sleep(700);
    if (clickText("\u786E\u8BA4")) {
      confirmed = true;
      break;
    }
  }
  let text = "";
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12e3) {
    text = (document.body?.innerText || "").replace(/\s+/g, " ");
    if (/正确率|平均分|答对/.test(text)) break;
    await sleep(700);
  }
  return { submitted, confirmed, text: text.slice(-500) };
}
async function paperProgress(session, courseId, groupId, auth) {
  try {
    const progress = await fetchText(
      session,
      `${UCONTENT_BASE}/api/mobile/user_module/${courseId}/${groupId}/progress/v2/`,
      annotatorHeaders(auth)
    );
    return JSON.parse(progress.text)?.data ?? null;
  } catch {
    return null;
  }
}
async function studyQuizPaper(session, course, unit, auth) {
  const courseId = course.content_id;
  const groupId = String(unit.id ?? "").split("::")[0];
  if (!UNIT_TEST_ENABLED) {
    return {
      status: "needs_human",
      reason: "\u5355\u5143\u6D4B\u8BD5\u662F\u72EC\u7ACB\u7684 uexercise \u8BD5\u5377\u5E94\u7528\uFF1B\u8BBE\u7F6E enable_unit_test=true \u624D\u4F1A\u5728\u6A21\u5757\u5185\u81EA\u52A8\u7B54\u9898/\u4EA4\u5377",
      evidence: { exam: unit.exam ?? null }
    };
  }
  const url = paperCoursewareUrl(course, unit);
  if (!url) {
    return { status: "needs_human", reason: "\u5355\u5143\u6D4B\u8BD5\u7F3A\u5C11\u8BFE\u4EF6\u8DEF\u5F84", evidence: { exam: unit.exam ?? null } };
  }
  let paperPage = null;
  let keepAlive = null;
  try {
    const opened = await hostCall("cw.browser.open", { session, url, purpose: "study" });
    const first = String(opened?.page ?? "");
    if (!first) return { status: "needs_human", reason: "\u5B98\u65B9\u6D4F\u89C8\u5668\u6CA1\u6709\u8FD4\u56DE\u9875\u9762\u53E5\u67C4" };
    let examUrl = "";
    try {
      const resolved = await hostCall("cw.browser.evaluate", {
        session,
        page: first,
        stage: "save_study",
        expression: `(${openUnitTestPage.toString()})()`
      });
      examUrl = String(resolved?.src ?? "");
      if (!resolved?.ok) {
        return {
          status: "needs_human",
          reason: `\u6CA1\u6709\u6253\u5F00\u5355\u5143\u6D4B\u8BD5\u8BD5\u5377\uFF1A${String(resolved?.error ?? "unknown")}`,
          evidence: { courseware_url: url, detail: resolved?.text ?? "" }
        };
      }
    } finally {
      await hostCall("cw.browser.close", { session, page: first }).catch(() => {
      });
    }
    const openedPaper = await hostCall("cw.browser.open", { session, url: examUrl, purpose: "study" });
    paperPage = String(openedPaper?.page ?? "");
    if (!paperPage) return { status: "needs_human", reason: "\u8BD5\u5377\u9875\u9762\u6CA1\u6709\u6253\u5F00" };
    keepAlive = setInterval(() => {
      if (!paperPage) return;
      void hostCall("cw.browser.evaluate", {
        session,
        page: paperPage,
        stage: "read",
        expression: "1"
      }).catch(() => {
      });
    }, 45e3);
    keepAlive.unref?.();
    let details = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      details = await hostCall("cw.browser.evaluate", {
        session,
        page: paperPage,
        stage: "save_study",
        expression: `(${readUnitTestPaper.toString()})()`
      });
      if (details?.ready && Number(details?.count) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    if (!details?.ready || !Number(details?.count)) {
      return {
        status: "needs_human",
        reason: "\u8BD5\u5377\u9875\u9762\u6CA1\u6709\u89E3\u6790\u51FA\u9898\u76EE",
        evidence: {
          exam_url: examUrl,
          page_url: details?.url ?? "",
          title: details?.title ?? "",
          loading: details?.loading ?? false,
          body: String(details?.body ?? "").slice(0, 200)
        }
      };
    }
    const answers = await solvePaperAnswers(session, details);
    const unanswered = (details.questions ?? []).map((question) => String(question.index)).filter((index) => !answers[index]);
    if (unanswered.length) {
      return {
        status: "needs_human",
        reason: `\u5355\u5143\u6D4B\u8BD5\u6709 ${unanswered.length} \u9898\u6CA1\u6709\u751F\u6210\u7B54\u6848\uFF0C\u672A\u63D0\u4EA4`,
        evidence: { unanswered, exam: unit.exam ?? null }
      };
    }
    const filled = await hostCall("cw.browser.evaluate", {
      session,
      page: paperPage,
      stage: "save_study",
      expression: `(${fillUnitTestPaper.toString()})(${JSON.stringify(answers)})`
    });
    if (filled?.missing?.length) {
      return {
        status: "needs_human",
        reason: `\u6709 ${filled.missing.length} \u9898\u6CA1\u6709\u586B\u4E0A\uFF0C\u672A\u63D0\u4EA4`,
        evidence: { filled, exam: unit.exam ?? null }
      };
    }
    if (UNIT_TEST_DRY_RUN) {
      await hostCall("cw.browser.close", { session, page: paperPage }).catch(() => {
      });
      paperPage = null;
      return {
        status: "needs_human",
        reason: "\u5355\u5143\u6D4B\u8BD5\u6F14\u7EC3\u6A21\u5F0F\uFF1A\u5DF2\u89E3\u6790\u5E76\u586B\u597D\u7B54\u6848\uFF0C\u672A\u63D0\u4EA4",
        evidence: {
          dry_run: true,
          count: details.count,
          filled,
          answers,
          exam: unit.exam ?? null
        }
      };
    }
    let submitResult = null;
    try {
      submitResult = await hostCall("cw.browser.evaluate", {
        session,
        page: paperPage,
        stage: "save_study",
        expression: `(${submitUnitTestPaper.toString()})()`
      });
    } catch (error) {
      log("warn", `paper submit evaluate failed: ${errorText(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4e3));
    await hostCall("cw.browser.close", { session, page: paperPage }).catch(() => {
    });
    paperPage = null;
    const progress = await paperProgress(session, courseId, groupId, auth);
    const state = Number(progress?.state?.state ?? 0);
    const scorePct = Number(progress?.state?.real_score_pct ?? progress?.state?.score_pct ?? 0);
    const score = progress?.state?.score ?? null;
    if (state === 1) {
      return {
        status: "completed",
        evidence: {
          platform_confirmed: true,
          browser: true,
          score,
          score_pct: scorePct,
          exam: unit.exam ?? null,
          submit: submitResult?.text ?? ""
        },
        checkpoint: { phase: "done" }
      };
    }
    return {
      status: "needs_human",
      reason: `\u5355\u5143\u6D4B\u8BD5\u5DF2\u63D0\u4EA4\u4F46\u5E73\u53F0\u672A\u786E\u8BA4\uFF08state ${state}\uFF09`,
      evidence: { state, score_pct: scorePct, submit: submitResult, exam: unit.exam ?? null }
    };
  } catch (error) {
    return { status: "needs_human", reason: `\u5355\u5143\u6D4B\u8BD5\u6D41\u7A0B\u5931\u8D25\uFF1A${errorText(error)}` };
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    if (paperPage) await hostCall("cw.browser.close", { session, page: paperPage }).catch(() => {
    });
  }
}
async function studyTask(session, course, unit, auth) {
  const courseId = course.content_id;
  const groupId = String(unit.id ?? "").split("::")[0];
  if (String(unit.selectable_note ?? "") === "quiz-paper-link" || unit.exam) {
    return studyQuizPaper(session, course, unit, auth);
  }
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
  if (isOralTask(decoded)) {
    return { status: "needs_human", reason: "\u53E3\u8BED/\u5F55\u97F3\u9898\uFF0C\u9700\u8981\u4EBA\u5DE5\u5B8C\u6210" };
  }
  const questionGroup = findQuestionGroup(decoded);
  if (!questionGroup) {
    return { status: "needs_human", reason: "\u9898\u7EC4\u5185\u5BB9\u91CC\u6CA1\u6709\u9898\u76EE" };
  }
  const category = String(questionGroup.category ?? "").toLowerCase();
  const isFill = /fillblank/.test(category);
  const isChoice = category === "singlechoice" || category === "truefalse" || category === "true_false" || category === "choice";
  if (isFill) {
    if (!isSinglePageTask(questionsList)) {
      if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
        return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
      }
      return { status: "needs_human", reason: "\u591A\u9875\u586B\u7A7A\u9898\u4F1A\u8BA1\u5206\uFF0C\u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED" };
    }
    if (BROWSER_STUDY) {
      const browserResult = await studyFillblankBrowser(
        session,
        course,
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
    if (!isSinglePageTask(questionsList)) {
      if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
        return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
      }
      return { status: "needs_human", reason: "\u591A\u9875\u9009\u62E9\u9898\u4F1A\u8BA1\u5206\uFF0C\u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED" };
    }
    if (BROWSER_STUDY) {
      const browserResult = await studyChoiceBrowser(
        session,
        course,
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
  const isSequence = category === "sequence";
  const isMulti = category === "multichoice";
  if (isSequence || isMulti) {
    if (BROWSER_STUDY || SETTINGS.enable_task_submit === true) {
      return studyObjectiveApi(session, courseId, groupId, decoded, questionGroup, questionsList, indexMap, auth, minScorePct);
    }
    return { status: "needs_human", reason: "\u6392\u5E8F/\u591A\u9009\u9898\u4F1A\u8BA1\u5206\uFF0C\u81EA\u52A8\u63D0\u4EA4\u9ED8\u8BA4\u5173\u95ED" };
  }
  if (isShortAnswerTask(category, decoded)) {
    return studyShortAnswerApi(
      session,
      courseId,
      groupId,
      decoded,
      questionGroup,
      questionsList,
      indexMap,
      auth,
      minScorePct
    );
  }
  if (isOralTask(decoded)) {
    return {
      status: "needs_human",
      reason: "\u53E3\u8BED/\u5F55\u97F3\u9898\uFF0C\u9700\u8981\u4EBA\u5DE5\u5B8C\u6210"
    };
  }
  return {
    status: "needs_human",
    reason: `\u672A\u652F\u6301\u7684\u4EFB\u52A1\u7C7B\u578B\uFF08${category || Object.keys(decoded ?? {}).join(",") || "unknown"}\uFF09`
  };
}
async function studyStep(params) {
  const session = String(params.session ?? "");
  const unit = params.unit ?? {};
  const rawId = String(unit.id ?? "");
  if (!rawId) throw { code: "invalid_params", message: "\u7F3A\u5C11\u5355\u5143 id" };
  const auth = await readAuth(session);
  const course = await resolveCourse(session, params.course, auth);
  if (String(unit.kind) === "document") {
    return studyTask(session, course, unit, auth);
  }
  return studyLeaf(session, course.content_id, unit, auth);
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
