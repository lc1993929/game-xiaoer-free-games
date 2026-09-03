const SESSION_KEY = "game_xiaoer_auth_session_v1";
const CONSENT_KEY = "game_xiaoer_manual_claim_consent_v1";

export function normalizeClaimConfig(value) {
  const enabled = value?.mode === "manual_claims";
  const supabaseUrl = safeHttps(value?.supabase_url);
  const anonKey = typeof value?.supabase_anon_key === "string" ? value.supabase_anon_key.trim() : "";
  return {
    mode: enabled && supabaseUrl && anonKey ? "manual_claims" : "disabled",
    reason: String(value?.reason || ""),
    supabase_url: supabaseUrl,
    supabase_anon_key: anonKey,
    function_name: /^[a-z0-9-]+$/.test(value?.function_name || "") ? value.function_name : "claim-records-api",
    auth_email_gate_function_name: /^[a-z0-9-]+$/.test(value?.auth_email_gate_function_name || "") ? value.auth_email_gate_function_name : "auth-email-gate",
    consent_version: String(value?.cross_border?.consent_version || ""),
  };
}

export class ClaimRecordsClient {
  constructor(rawConfig, storage = globalThis.sessionStorage) {
    this.config = normalizeClaimConfig(rawConfig);
    this.storage = storage;
    this.session = readSession(storage);
  }

  getSession() { return this.session; }
  acceptConsent() {
    if (this.config.mode !== "manual_claims" || !this.config.consent_version) throw new Error("同步服务尚未开放");
    const receipt = { accepted: true, consent_version: this.config.consent_version, consented_at: new Date().toISOString() };
    this.storage?.setItem(CONSENT_KEY, JSON.stringify(receipt));
    return receipt;
  }
  readConsent() { try { return JSON.parse(this.storage?.getItem(CONSENT_KEY) || "null"); } catch { return null; } }

  async requestCode(email) {
    if (!validEmail(email)) throw new Error("请输入有效邮箱地址");
    const receipt = this.readConsent();
    if (!validReceipt(receipt, this.config.consent_version)) throw new Error("请先同意邮箱和手动领取记录用于跨设备同步");
    await requestJson(`${this.config.supabase_url}/functions/v1/${this.config.auth_email_gate_function_name}/preauthorize`, { method: "POST", headers: { apikey: this.config.supabase_anon_key }, body: { email, ...receipt } });
    await requestJson(`${this.config.supabase_url}/auth/v1/otp`, { method: "POST", headers: { apikey: this.config.supabase_anon_key }, body: { email, create_user: true } });
    return { sent: true };
  }

  async verifyCode(email, code) {
    if (!validEmail(email) || !/^\d{6,8}$/.test(String(code || ""))) throw new Error("请输入邮件中的验证码");
    const payload = await requestJson(`${this.config.supabase_url}/auth/v1/verify`, { method: "POST", headers: { apikey: this.config.supabase_anon_key }, body: { email, token: String(code), type: "email" } });
    this.session = sessionFromPayload(payload, email);
    writeSession(this.storage, this.session);
    await this.api("/consents/cross-border", { method: "POST", body: this.readConsent() });
    this.storage?.removeItem(CONSENT_KEY);
    return this.session;
  }

  async listRecords() { return (await this.api("/claim-records")).records || []; }
  async saveRecord(record) { return (await this.api("/claim-records", { method: "POST", body: record })).record; }
  async deleteRecord(offerId) { return this.api(`/claim-records/${encodeURIComponent(offerId)}`, { method: "DELETE" }); }
  async deleteAccount() { await this.api("/account", { method: "DELETE" }); await this.logout(false); }
  async logout(callRemote = true) {
    if (callRemote && this.session?.access) { try { await requestJson(`${this.config.supabase_url}/auth/v1/logout`, { method: "POST", headers: { apikey: this.config.supabase_anon_key, Authorization: `Bearer ${this.session.access}` } }); } catch {} }
    this.session = null;
    this.storage?.removeItem(SESSION_KEY);
    this.storage?.removeItem(CONSENT_KEY);
  }

  async api(path, options = {}) {
    await this.ensureSession();
    return requestJson(`${this.config.supabase_url}/functions/v1/${this.config.function_name}${path}`, { ...options, headers: { apikey: this.config.supabase_anon_key, Authorization: `Bearer ${this.session.access}`, ...(options.headers || {}) } });
  }
  async ensureSession() {
    if (!this.session) throw new Error("请先用邮箱登录");
    if (this.session.expires_at - Date.now() > 60000) return;
    if (!this.session.refresh) { await this.logout(false); throw new Error("登录已过期，请重新获取验证码"); }
    const payload = await requestJson(`${this.config.supabase_url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: this.config.supabase_anon_key }, body: { refresh_token: this.session.refresh } });
    this.session = sessionFromPayload(payload, this.session.email);
    writeSession(this.storage, this.session);
  }
}

async function requestJson(url, options = {}) { const response = await fetch(url, { method: options.method || "GET", headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined, cache: "no-store" }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || payload.message || `请求失败（${response.status}）`); return payload; }
function sessionFromPayload(payload, email) { if (!payload?.access_token) throw new Error("登录响应缺少有效会话"); return { email: String(payload.user?.email || email), access: String(payload.access_token), refresh: String(payload.refresh_token || ""), expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000 }; }
function readSession(storage) { try { const value = JSON.parse(storage?.getItem(SESSION_KEY) || "null"); return value?.access && value?.email && Number.isFinite(value.expires_at) ? value : null; } catch { return null; } }
function writeSession(storage, session) { try { storage?.setItem(SESSION_KEY, JSON.stringify(session)); } catch {} }
function validReceipt(receipt, version) { const time = new Date(receipt?.consented_at || "").getTime(); return receipt?.accepted === true && receipt?.consent_version === version && Number.isFinite(time) && Math.abs(Date.now() - time) <= 15 * 60 * 1000; }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function safeHttps(value) { try { const url = new URL(String(value || "")); return url.protocol === "https:" ? url.href.replace(/\/$/, "") : null; } catch { return null; } }
