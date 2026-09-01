import {
  PLATFORM_CAPABILITIES,
  getOfferCatalogId,
  indexVerificationResults,
  sanitizeLink,
} from "./verification.mjs";

const APP_SESSION_KEY = "game_xiaoer_auth_session_v1";
const TEST_PLATFORM_BY_MODE = Object.freeze({ itch_test: "itch_io" });
const BACKEND_MODES = new Set(["login_test", ...Object.keys(TEST_PLATFORM_BY_MODE), "live"]);

export function normalizeVerificationConfig(value) {
  const mode = ["disabled", "demo", ...BACKEND_MODES].includes(value?.mode) ? value.mode : "disabled";
  const emailFlow = ["magic_link", "otp"].includes(value?.email_flow) ? value.email_flow : "magic_link";
  const supabaseUrl = safeHttpsUrl(value?.supabase_url);
  const anonKey = typeof value?.supabase_anon_key === "string" ? value.supabase_anon_key.trim() : "";
  const functionName = /^[a-z0-9-]+$/.test(value?.function_name || "") ? value.function_name : "library-api";
  if (BACKEND_MODES.has(mode) && (!supabaseUrl || !anonKey)) {
    return { mode: "disabled", email_flow: emailFlow, reason: "领取状态后端尚未完成配置。", supabase_url: null, supabase_anon_key: "", function_name: functionName };
  }
  return {
    mode,
    email_flow: emailFlow,
    reason: String(value?.reason || ""),
    supabase_url: supabaseUrl,
    supabase_anon_key: anonKey,
    function_name: functionName,
  };
}

export function createVerificationClient(rawConfig, storage = globalThis.sessionStorage) {
  const config = normalizeVerificationConfig(rawConfig);
  if (config.mode === "demo") return new DemoVerificationClient(config, storage);
  if (BACKEND_MODES.has(config.mode)) return new SupabaseVerificationClient(config, storage);
  return new DisabledVerificationClient(config);
}

export function readItchOAuthFragment(locationLike = globalThis.location) {
  const fragment = new URLSearchParams(String(locationLike?.hash || "").replace(/^#/, ""));
  const query = new URLSearchParams(String(locationLike?.search || "").replace(/^\?/, ""));
  const platform = fragment.get("platform") || query.get("oauth");
  const state = fragment.get("state") || query.get("state");
  const token = fragment.get("access_token");
  if (platform !== "itch_io" || !state || !token) return null;
  return { platform, state, token };
}

export function readSupabaseAuthFragment(locationLike = globalThis.location) {
  const fragment = new URLSearchParams(String(locationLike?.hash || "").replace(/^#/, ""));
  if (!fragment.get("access_token") || fragment.get("platform") === "itch_io") return null;
  const accessToken = fragment.get("access_token");
  const expiresIn = Number(fragment.get("expires_in") || 3600);
  return {
    access_token: accessToken,
    refresh_token: fragment.get("refresh_token") || "",
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    token_type: fragment.get("token_type") || "bearer",
    type: fragment.get("type") || "magiclink",
    user: { email: emailFromJwt(accessToken) },
  };
}

class DisabledVerificationClient {
  constructor(config) {
    this.config = config;
    this.mode = "disabled";
  }

  getSession() { return null; }
  async requestCode() { throw new Error(this.config.reason || "领取状态后端尚未启用"); }
  async verifyCode() { throw new Error(this.config.reason || "领取状态后端尚未启用"); }
  async checkBackendSession() { throw new Error(this.config.reason || "领取状态后端尚未启用"); }
  async logout() {}
  async listLinks() { return []; }
  async listResults() { return []; }
  async startLink() { throw new Error("该平台关联功能尚未启用"); }
  async completeItchLink() { throw new Error("itch.io 关联功能尚未启用"); }
  async runVerification() { throw new Error("领取状态核验尚未启用"); }
  async clearResults() {}
  async unlink() {}
  async deleteAccount() { throw new Error("领取状态后端尚未启用"); }
}

class DemoVerificationClient {
  constructor(config, storage) {
    this.config = config;
    this.mode = "demo";
    this.storage = storage;
    this.session = readStoredSession(storage);
    this.links = [];
    this.results = [];
  }

  getSession() { return this.session; }

  async requestCode(email) {
    if (!validEmail(email)) throw new Error("请输入有效邮箱地址");
    return { sent: true, demo_code: "123456" };
  }

  async verifyCode(email, code) {
    if (!validEmail(email) || code !== "123456") throw new Error("本地演示验证码为 123456");
    this.session = { email, access: "demo-session", refresh: "", expires_at: Date.now() + 3600000 };
    writeStoredSession(this.storage, this.session);
    return this.session;
  }

  async checkBackendSession() {
    if (!this.session) throw new Error("请先用邮箱登录");
    return { authenticated: true };
  }

  async logout() {
    this.session = null;
    removeStoredSession(this.storage);
  }

  async listLinks() { return this.links.map(sanitizeLink).filter(Boolean); }
  async listResults() { return this.results; }

  async startLink(platform) {
    const capability = PLATFORM_CAPABILITIES.find((item) => item.platform === platform);
    if (!capability || capability.capability === "unsupported" || capability.capability === "public_activity_gate") {
      throw new Error(capability?.description || "该平台暂无法关联");
    }
    const link = {
      platform,
      display_name: platform === "steam_cn" ? "演示 Steam 玩家" : "演示 itch.io 玩家",
      external_user_id: `demo-${platform}`,
      status: "linked",
      linked_at: new Date().toISOString(),
      last_checked_at: null,
    };
    this.links = [...this.links.filter((item) => item.platform !== platform), link];
    return { linked: true };
  }

  async completeItchLink() { return { linked: true }; }

  async runVerification(offers) {
    const linked = new Set(this.links.map((item) => item.platform));
    const now = new Date().toISOString();
    this.results = (offers || []).filter((offer) => linked.has(offer.platform)).map((offer, index) => ({
      offer_id: offer.offer_id,
      platform: offer.platform,
      status: getOfferCatalogId(offer) ? (index % 2 ? "likely_owned_activity" : "confirmed_owned") : "not_detected",
      evidence_type: getOfferCatalogId(offer) ? (index % 2 ? "playtime" : "official_owned_library") : "catalog_id_missing",
      access_type: offer.ownership === "permanent" ? "permanent" : "unknown",
      observed_at: now,
      checked_at: now,
      detail: "本地演示结果，不连接真实平台。",
    }));
    return this.results;
  }

  async clearResults() { this.results = []; }

  async unlink(platform) {
    this.links = this.links.filter((item) => item.platform !== platform);
    this.results = this.results.filter((item) => item.platform !== platform);
  }

  async deleteAccount() {
    this.links = [];
    this.results = [];
    await this.logout();
  }
}

class SupabaseVerificationClient {
  constructor(config, storage) {
    this.config = config;
    this.mode = config.mode;
    this.storage = storage;
    this.session = readStoredSession(storage);
  }

  getSession() { return this.session; }

  acceptAuthCallback(locationLike = globalThis.location) {
    const payload = readSupabaseAuthFragment(locationLike);
    if (!payload) return null;
    this.session = sessionFromPayload(payload, payload.user.email);
    writeStoredSession(this.storage, this.session);
    return this.session;
  }

  async requestCode(email) {
    if (!validEmail(email)) throw new Error("请输入有效邮箱地址");
    await this.authFetch("/auth/v1/otp", {
      method: "POST",
      body: { email, create_user: this.mode === "live" },
    }, false);
    return { sent: true, delivery: this.config.email_flow };
  }

  async verifyCode(email, code) {
    if (!validEmail(email) || !/^\d{6,8}$/.test(String(code || ""))) throw new Error("请输入邮件中的验证码");
    const payload = await this.authFetch("/auth/v1/verify", {
      method: "POST",
      body: { email, token: String(code), type: "email" },
    }, false);
    this.session = sessionFromPayload(payload, email);
    writeStoredSession(this.storage, this.session);
    return this.session;
  }

  async checkBackendSession() {
    await this.ensureSession();
    const base = `${this.config.supabase_url}/functions/v1/${this.config.function_name}`;
    await requestJson(`${base}/links`, {
      headers: {
        apikey: this.config.supabase_anon_key,
        Authorization: `Bearer ${this.session.access}`,
      },
    });
    return { authenticated: true };
  }

  async logout() {
    if (this.session?.access) {
      try { await this.authFetch("/auth/v1/logout", { method: "POST" }, true); } catch {}
    }
    this.session = null;
    removeStoredSession(this.storage);
  }

  async listLinks() {
    if (this.mode === "login_test") return [];
    this.requireBackend();
    const payload = await this.apiFetch("/links");
    const links = (payload.links || []).map(sanitizeLink).filter(Boolean);
    const platform = TEST_PLATFORM_BY_MODE[this.mode];
    return platform ? links.filter((link) => link.platform === platform) : links;
  }

  async listResults() {
    if (this.mode === "login_test") return [];
    this.requireBackend();
    const payload = await this.apiFetch("/verification/results");
    const results = Object.values(indexVerificationResults(payload.results || []));
    const platform = TEST_PLATFORM_BY_MODE[this.mode];
    return platform ? results.filter((result) => result.platform === platform) : results;
  }

  async startLink(platform) {
    this.requirePlatform(platform);
    return this.apiFetch(`/links/${encodeURIComponent(platform)}/start`, { method: "POST" });
  }

  async completeItchLink({ state, token }) {
    this.requirePlatform("itch_io");
    return this.apiFetch("/callbacks/itch", { method: "POST", body: { state, token } });
  }

  async runVerification() {
    this.requireBackend();
    const testPlatform = TEST_PLATFORM_BY_MODE[this.mode];
    const options = testPlatform
      ? { method: "POST", body: { platforms: [testPlatform] } }
      : { method: "POST" };
    const payload = await this.apiFetch("/verification/run", options);
    const results = Object.values(indexVerificationResults(payload.results || []));
    return testPlatform ? results.filter((result) => result.platform === testPlatform) : results;
  }

  async clearResults() {
    this.requireLive();
    await this.apiFetch("/verification/results", { method: "DELETE" });
  }

  async unlink(platform) {
    this.requirePlatform(platform);
    await this.apiFetch(`/links/${encodeURIComponent(platform)}`, { method: "DELETE" });
  }

  async deleteAccount() {
    this.requireLive();
    await this.apiFetch("/account", { method: "DELETE" });
    await this.logout();
  }

  async apiFetch(path, options = {}) {
    this.requireBackend();
    await this.ensureSession();
    const base = `${this.config.supabase_url}/functions/v1/${this.config.function_name}`;
    return requestJson(`${base}${path}`, {
      ...options,
      headers: {
        apikey: this.config.supabase_anon_key,
        Authorization: `Bearer ${this.session.access}`,
        ...(options.headers || {}),
      },
    });
  }

  async authFetch(path, options = {}, withSession = false) {
    const headers = { apikey: this.config.supabase_anon_key, ...(options.headers || {}) };
    if (withSession && this.session?.access) headers.Authorization = `Bearer ${this.session.access}`;
    return requestJson(`${this.config.supabase_url}${path}`, { ...options, headers });
  }

  async ensureSession() {
    if (!this.session) throw new Error("请先用邮箱登录");
    if (this.session.expires_at - Date.now() > 60000) return;
    if (!this.session.refresh) {
      await this.logout();
      throw new Error("登录已过期，请重新获取登录邮件");
    }
    const payload = await this.authFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: this.session.refresh },
    }, false);
    this.session = sessionFromPayload(payload, this.session.email);
    writeStoredSession(this.storage, this.session);
  }

  requireLive() {
    if (TEST_PLATFORM_BY_MODE[this.mode]) {
      throw new Error("当前测试只开放 itch.io 关联与核验，不开放全量清理或删除账号");
    }
    if (this.mode !== "live") throw new Error("当前只开放邮箱登录回跳测试，游戏平台关联和核验尚未开放");
  }

  requireBackend() {
    if (![...Object.keys(TEST_PLATFORM_BY_MODE), "live"].includes(this.mode)) {
      throw new Error("当前只开放邮箱登录回跳测试，游戏平台关联和核验尚未开放");
    }
  }

  requirePlatform(platform) {
    this.requireBackend();
    const testPlatform = TEST_PLATFORM_BY_MODE[this.mode];
    if (testPlatform && platform !== testPlatform) {
      throw new Error("当前测试仅开放 itch.io 关联与核验");
    }
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `请求失败（${response.status}）`);
  return payload;
}

function sessionFromPayload(payload, email) {
  if (!payload?.access_token) throw new Error("登录响应缺少有效会话");
  return {
    email: String(payload.user?.email || email || ""),
    access: String(payload.access_token),
    refresh: String(payload.refresh_token || ""),
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
}

function readStoredSession(storage) {
  try {
    const value = JSON.parse(storage?.getItem(APP_SESSION_KEY) || "null");
    if (!value?.access || !value?.email || !Number.isFinite(value.expires_at)) return null;
    return value;
  } catch {
    return null;
  }
}

function writeStoredSession(storage, session) {
  try { storage?.setItem(APP_SESSION_KEY, JSON.stringify(session)); } catch {}
}

function removeStoredSession(storage) {
  try { storage?.removeItem(APP_SESSION_KEY); } catch {}
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function emailFromJwt(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return "";
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(decodeURIComponent(Array.from(atob(padded), (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")));
    return validEmail(payload?.email) ? String(payload.email) : "";
  } catch {
    return "";
  }
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co") ? url.origin : null;
  } catch {
    return null;
  }
}
