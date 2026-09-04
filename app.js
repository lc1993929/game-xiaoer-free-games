import { CLAIM_RECORDS_STORAGE_KEY, createClaimState, listClaimRecords, markClaimed, mergeClaimRecords, sanitizeClaimState, unmarkClaimed } from "./claim_records.mjs";
import { ClaimRecordsClient } from "./claim_records_client.mjs";

const TYPES = { keep: "永久入库", subscription: "会员可领", free_weekend: "限时畅玩", demo: "Demo", f2p: "免费游玩" };
const OWNERSHIP = { permanent: "领取后永久拥有", while_subscribed: "会员期内可玩", temporary: "活动期间可玩", no_claim: "无需入库" };
const GROUPS = [["keep", "永久入库"], ["subscription", "会员可领"], ["free_weekend", "限时畅玩"], ["trial", "试玩与免费游玩"]];
const state = { offers: [], historyOffers: [], filter: "all", platform: "all", claims: createClaimState(), persistent: true, client: new ClaimRecordsClient(window.GAME_XIAOER_CLAIM_CONFIG || {}), session: null, busy: false, deleteArmed: false, loading: true, loadError: false, drawerReturnFocus: null };

function loadLocal() { try { const key = `${CLAIM_RECORDS_STORAGE_KEY}_probe`; localStorage.setItem(key, "1"); localStorage.removeItem(key); return sanitizeClaimState(JSON.parse(localStorage.getItem(CLAIM_RECORDS_STORAGE_KEY) || "null")); } catch { state.persistent = false; return createClaimState(); } }
function saveLocal() { if (!state.persistent) return; try { localStorage.setItem(CLAIM_RECORDS_STORAGE_KEY, JSON.stringify(state.claims)); } catch { state.persistent = false; } }
function formatDate(value, timezone = "Asia/Shanghai") { if (!value) return "长期有效"; return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatClaimedAt(value) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value)); }
function countdown(value) { if (!value) return "长期有效"; const ms = new Date(value).valueOf() - Date.now(); if (ms <= 0) return "已经结束"; const hours = Math.floor(ms / 3600000); return hours >= 24 ? `还剩 ${Math.floor(hours / 24)} 天` : `仅剩 ${Math.max(1, hours)} 小时`; }
function matches(offer) { if (state.platform !== "all" && offer.platform !== state.platform) return false; if (state.filter === "all") return true; if (state.filter === "trial") return ["demo", "f2p"].includes(offer.offer_type); return offer.offer_type === state.filter; }
function setMessage(message, tone = "") { const node = document.querySelector("#claim-message"); node.textContent = message || ""; node.dataset.tone = tone; }

async function toggleClaim(offer) {
  if (state.busy) return;
  state.busy = true;
  const existing = state.claims.records[offer.offer_id];
  try {
    state.claims = existing ? unmarkClaimed(state.claims, offer.offer_id) : markClaimed(state.claims, offer);
    saveLocal(); renderAll();
    if (state.session) {
      if (existing) await state.client.deleteRecord(offer.offer_id); else await state.client.saveRecord(state.claims.records[offer.offer_id]);
      setMessage(existing ? "已撤销并同步" : "已同步到你的账号", "success");
    }
  } catch (error) {
    state.claims = existing ? markClaimed(state.claims, existing, new Date(existing.claimed_at)) : unmarkClaimed(state.claims, offer.offer_id);
    saveLocal(); setMessage(error.message, "error");
  } finally { state.busy = false; renderAll(); }
}

function renderSummary() {
  document.querySelector("#summary-loading").hidden = !state.loading;
  document.querySelector("#summary-content").hidden = state.loading;
  if (state.loading) return;
  document.querySelector("#active-count").textContent = state.offers.length;
  const deadline = state.offers.filter((offer) => offer.ends_at).sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at))[0];
  document.querySelector("#next-deadline").textContent = deadline ? `最近截止：${deadline.title} · ${formatDate(deadline.ends_at, deadline.timezone)}` : "当前活动没有临近截止项";
}

function renderOffers() {
  const list = document.querySelector("#offer-list"); const template = document.querySelector("#offer-template"); const offers = state.offers.filter(matches); list.replaceChildren();
  for (const [key, label] of GROUPS) {
    const group = offers.filter((offer) => key === "trial" ? ["demo", "f2p"].includes(offer.offer_type) : offer.offer_type === key); if (!group.length) continue;
    const section = document.createElement("section"); section.className = "offer-section"; section.innerHTML = `<div class="offer-section-heading"><h2>${label}</h2><span>${group.length} 款</span></div>`; const cards = document.createElement("div"); cards.className = "offer-cards";
    for (const offer of group) {
      const fragment = template.content.cloneNode(true); const image = fragment.querySelector(".cover-image"); const fallback = fragment.querySelector(".cover-fallback"); image.src = offer.image_url || ""; image.alt = `${offer.title} 游戏封面`; if (!offer.image_url) { image.hidden = true; fallback.hidden = false; } image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
      fragment.querySelector(".platform").textContent = offer.platform_label || offer.platform; fragment.querySelector(".region").textContent = (offer.regions || []).join(" / "); fragment.querySelector(".type").textContent = TYPES[offer.offer_type] || offer.offer_type; fragment.querySelector(".title").textContent = offer.title; fragment.querySelector(".ownership").textContent = OWNERSHIP[offer.ownership] || offer.ownership; fragment.querySelector(".membership").textContent = offer.membership_required ? "需要会员" : "无需会员"; fragment.querySelector(".ends-at").textContent = offer.ends_at ? `${formatDate(offer.ends_at, offer.timezone)} 截止` : "长期有效"; fragment.querySelector(".countdown").textContent = countdown(offer.ends_at); fragment.querySelector(".claim-link").href = offer.official_url;
      const button = fragment.querySelector(".claim-record-button"); const undo = fragment.querySelector(".claim-undo-button"); const label = fragment.querySelector(".claim-state-label"); const claimed = Boolean(state.claims.records[offer.offer_id]);
      label.textContent = claimed ? "已加入我的领取" : "领完了，记一下"; button.classList.toggle("is-claimed", claimed); button.setAttribute("aria-pressed", String(claimed)); button.setAttribute("aria-label", claimed ? `${offer.title} 已加入我的领取` : `将 ${offer.title} 标记为已领取`); button.disabled = state.busy || claimed; undo.hidden = !claimed; undo.disabled = state.busy; undo.setAttribute("aria-label", `撤销 ${offer.title} 的已领取记录`); if (!claimed) button.addEventListener("click", () => toggleClaim(offer)); if (claimed) undo.addEventListener("click", () => toggleClaim(offer)); cards.append(fragment);
    }
    section.append(cards); list.append(section);
  }
  const empty = document.querySelector("#empty-state"); empty.hidden = state.loading || offers.length > 0; empty.querySelector("h2").textContent = state.loadError ? "活动加载失败" : "暂时没有可领活动"; empty.querySelector("p").textContent = state.loadError ? "网络开了个小差，请稍后再试。" : "有新的免费游戏时，这里会自动更新。"; document.querySelector("#retry-load").hidden = !state.loadError;
}

function renderHistory() {
  const list = document.querySelector("#claimed-list"); const template = document.querySelector("#claimed-record-template"); const records = listClaimRecords(state.claims); list.replaceChildren(); document.querySelector("#claimed-total").textContent = records.length; document.querySelector("#top-claimed-total").textContent = records.length; document.querySelector("#claimed-empty").hidden = records.length > 0;
  for (const record of records) { const fragment = template.content.cloneNode(true); fragment.querySelector(".claimed-record-title").textContent = record.title; fragment.querySelector(".claimed-record-meta").textContent = `${record.platform} · ${formatClaimedAt(record.claimed_at)}`; fragment.querySelector(".claimed-record-remove").addEventListener("click", () => toggleClaim(record)); list.append(fragment); }
}
function renderAccount() { const logged = Boolean(state.session); document.querySelector("#claim-login").hidden = logged || state.client.config.mode !== "manual_claims"; document.querySelector("#claim-account-panel").hidden = !logged; document.querySelector("#claim-account-state").textContent = logged ? "已同步" : "未登录"; document.querySelector("#claim-account-email").textContent = state.session?.email || ""; }
function renderAll() { renderSummary(); renderOffers(); renderHistory(); renderAccount(); }

function populatePlatforms() { const select = document.querySelector("#platform-filter"); select.replaceChildren(new Option("全部平台", "all")); const map = new Map(state.offers.map((offer) => [offer.platform, offer.platform_label || offer.platform])); for (const [value, label] of [...map].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"))) select.append(new Option(label, value)); document.querySelector("#platform-picker").hidden = map.size < 2; }
async function loadOffers() { state.loading = true; state.loadError = false; renderAll(); try { const [active, history] = await Promise.all([fetch("./offers.json", { cache: "no-store" }).then(checkJson), fetch("./history.json", { cache: "no-store" }).then(checkJson)]); state.offers = active.offers || []; state.historyOffers = history.offers || []; document.querySelector("#updated-at").textContent = `更新于 ${formatDate(active.generated_at)}`; populatePlatforms(); } catch { state.offers = []; state.historyOffers = []; state.loadError = true; document.querySelector("#updated-at").textContent = "更新失败"; } finally { state.loading = false; renderAll(); } }
function checkJson(response) { if (!response.ok) throw new Error("活动数据不可用"); return response.json(); }

async function syncAfterLogin() { const remote = await state.client.listRecords(); state.claims = mergeClaimRecords(state.claims, remote); saveLocal(); for (const record of listClaimRecords(state.claims)) await state.client.saveRecord(record); renderAll(); setMessage("本机与云端记录已合并", "success"); }
function bindAuth() {
  document.querySelector("#claim-consent-input").addEventListener("change", (event) => { if (event.target.checked) { try { state.client.acceptConsent(); } catch (error) { event.target.checked = false; setMessage(error.message, "error"); } } });
  document.querySelector("#claim-send-code").addEventListener("click", async () => { try { state.busy = true; await state.client.requestCode(document.querySelector("#claim-email").value.trim()); document.querySelector("#claim-code-row").hidden = false; setMessage("验证码已发送", "success"); } catch (error) { setMessage(error.message, "error"); } finally { state.busy = false; } });
  document.querySelector("#claim-login").addEventListener("submit", async (event) => { event.preventDefault(); try { state.busy = true; state.session = await state.client.verifyCode(document.querySelector("#claim-email").value.trim(), document.querySelector("#claim-code").value.trim()); await syncAfterLogin(); } catch (error) { setMessage(error.message, "error"); } finally { state.busy = false; } });
  document.querySelector("#claim-sign-out").addEventListener("click", async () => { await state.client.logout(); state.session = null; renderAll(); setMessage("已退出，本机记录仍然保留"); });
  document.querySelector("#claim-delete-account").addEventListener("click", async () => { const button = document.querySelector("#claim-delete-account"); if (!state.deleteArmed) { state.deleteArmed = true; button.textContent = "再次点击确认"; setMessage("再次点击会永久删除同步账号和云端记录", "error"); return; } try { await state.client.deleteAccount(); state.session = null; state.deleteArmed = false; button.textContent = "删除账号"; renderAll(); setMessage("同步账号已删除，本机记录仍保留", "success"); } catch (error) { setMessage(error.message, "error"); } });
}
function bindFilters() { document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".filter").forEach((item) => { const active = item === button; item.classList.toggle("is-active", active); item.setAttribute("aria-pressed", String(active)); }); state.filter = button.dataset.filter; renderOffers(); })); document.querySelector("#platform-filter").addEventListener("change", (event) => { state.platform = event.target.value; renderOffers(); }); }
function openDrawer() { state.drawerReturnFocus = document.activeElement; document.querySelector("#claims-overlay").hidden = false; document.body.classList.add("drawer-open"); document.querySelector("#claims-drawer").focus(); }
function closeDrawer() { document.querySelector("#claims-overlay").hidden = true; document.body.classList.remove("drawer-open"); state.drawerReturnFocus?.focus?.(); }
function bindDrawer() { document.querySelector("#open-claims").addEventListener("click", openDrawer); document.querySelector("#close-claims").addEventListener("click", closeDrawer); document.querySelector("#claims-overlay").addEventListener("click", (event) => { if (event.target.id === "claims-overlay") closeDrawer(); }); document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !document.querySelector("#claims-overlay").hidden) closeDrawer(); }); }
async function init() { state.claims = loadLocal(); state.session = state.client.getSession(); bindFilters(); bindAuth(); bindDrawer(); document.querySelector("#retry-load").addEventListener("click", loadOffers); renderAll(); await loadOffers(); if (state.session) { try { await syncAfterLogin(); } catch (error) { setMessage(error.message, "error"); } } }
init().catch((error) => { state.loading = false; state.loadError = true; setMessage(error.message, "error"); renderAll(); });
