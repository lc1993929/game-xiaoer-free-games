import {
  STORAGE_KEY,
  createDefaultQueueState,
  getNextPendingOffer,
  markOfferOpened,
  resetCurrentProgress,
  sanitizeQueueState,
  setOfferProgress,
  summarizeQueue,
  syncQueueProgress,
} from "./claim_queue.mjs";
import {
  PLATFORM_CAPABILITIES,
  VERIFICATION_STATUS,
  indexVerificationResults,
  sanitizeLink,
  selectVerificationOffers,
  summarizeVerificationResults,
} from "./verification.mjs";
import {
  createVerificationClient,
  readItchOAuthFragment,
} from "./verification_client.mjs";

const TYPE_LABELS = {
  keep: "永久入库",
  subscription: "会员可领",
  free_weekend: "限时畅玩",
  demo: "Demo",
  f2p: "常驻免费",
};

const OWNERSHIP_LABELS = {
  permanent: "领取后永久拥有",
  while_subscribed: "订阅有效期内可玩",
  temporary: "仅在活动期内可玩",
  no_claim: "无需领取",
};

const PROGRESS_LABELS = {
  user_confirmed: "本机记录：已确认",
  skipped: "本机记录：已跳过",
};

const GROUPS = [
  ["keep", "永久入库"],
  ["subscription", "会员可领"],
  ["free_weekend", "限时畅玩"],
  ["trial", "新试玩与常驻免费"],
];

const state = {
  offers: [],
  historyOffers: [],
  filter: "all",
  platform: "all",
  queue: createDefaultQueueState(),
  storagePersistent: true,
  storageMessage: "",
  batchOpen: false,
  clearArmed: false,
  clearTimer: null,
  verificationClient: createVerificationClient(window.GAME_XIAOER_VERIFICATION_CONFIG || {}),
  verificationSession: null,
  verificationLinks: [],
  verificationResults: {},
  verificationBusy: false,
  verificationDeleteArmed: false,
  verificationDeleteTimer: null,
};

function formatDate(value, timezone) {
  if (!value) return "未注明结束时间";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const valueOf = (type) => parts.find((part) => part.type === type)?.value;
  return `${valueOf("month")} 月 ${valueOf("day")} 日 ${valueOf("hour")}:${valueOf("minute")}`;
}

function formatCountdown(value) {
  if (!value) return "";
  const milliseconds = new Date(value).valueOf() - Date.now();
  if (milliseconds <= 0) return "已经结束";
  const totalHours = Math.floor(milliseconds / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `还剩 ${days} 天 ${hours} 小时`;
  return `还剩 ${Math.max(1, hours)} 小时`;
}

function loadQueueState() {
  try {
    const probe = `${STORAGE_KEY}_probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultQueueState();
    try {
      return sanitizeQueueState(JSON.parse(raw));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      state.storagePersistent = false;
      state.storageMessage = "本机记录已损坏，本次使用临时进度；刷新后会从空白记录重新开始。";
      return createDefaultQueueState();
    }
  } catch {
    state.storagePersistent = false;
    state.storageMessage = "当前浏览器不允许保存本机记录，本次进度会在关闭页面后消失。";
    return createDefaultQueueState();
  }
}

function saveQueueState() {
  if (!state.storagePersistent) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.queue));
  } catch {
    state.storagePersistent = false;
    state.storageMessage = "本机记录保存失败，本次进度会在关闭页面后消失。";
  }
}

function updateQueue(nextState) {
  state.queue = sanitizeQueueState(nextState);
  saveQueueState();
  renderBatchAssistant();
  render();
}

function matchesFilter(offer) {
  if (state.platform !== "all" && offer.platform !== state.platform) return false;
  if (state.filter === "all") return true;
  if (state.filter === "trial") return offer.offer_type === "demo" || offer.offer_type === "f2p";
  return offer.offer_type === state.filter;
}

function bindPlatformFilter() {
  const select = document.querySelector("#platform-filter");
  select.addEventListener("change", () => {
    state.platform = select.value;
    render();
  });
}

function populatePlatforms() {
  const select = document.querySelector("#platform-filter");
  const platforms = new Map(state.offers.map((offer) => [offer.platform, offer.platform_label || offer.platform]));
  for (const [value, label] of [...platforms.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"))) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}

function render() {
  const list = document.querySelector("#offer-list");
  const empty = document.querySelector("#empty-state");
  const template = document.querySelector("#offer-template");
  const offers = state.offers.filter(matchesFilter);
  list.replaceChildren();

  for (const [groupKey, groupLabel] of GROUPS) {
    const groupOffers = offers.filter((offer) => groupKey === "trial"
      ? offer.offer_type === "demo" || offer.offer_type === "f2p"
      : offer.offer_type === groupKey);
    if (!groupOffers.length) continue;
    const section = document.createElement("section");
    section.className = "offer-section";
    section.setAttribute("aria-label", groupLabel);
    const heading = document.createElement("div");
    heading.className = "offer-section-heading";
    heading.innerHTML = `<h2>${groupLabel}</h2><span>${groupOffers.length} 项</span>`;
    const cards = document.createElement("div");
    cards.className = "offer-cards";
    for (const offer of groupOffers) {
      const fragment = template.content.cloneNode(true);
      fragment.querySelector(".platform").textContent = offer.platform_label || offer.platform;
      fragment.querySelector(".region").textContent = (offer.regions || []).join(" / ");
      fragment.querySelector(".type").textContent = TYPE_LABELS[offer.offer_type] || offer.offer_type;
      fragment.querySelector(".title").textContent = offer.title;
      fragment.querySelector(".ownership").textContent = OWNERSHIP_LABELS[offer.ownership] || offer.ownership;
      fragment.querySelector(".membership").textContent = offer.membership_required ? "需要对应会员" : "无需会员";
      fragment.querySelector(".ends-at").textContent = formatDate(offer.ends_at, offer.timezone);
      fragment.querySelector(".countdown").textContent = formatCountdown(offer.ends_at);
      fragment.querySelector(".claim-link").href = offer.official_url;
      const progress = state.queue.progress[offer.offer_id]?.status;
      const progressNode = fragment.querySelector(".local-progress");
      progressNode.textContent = PROGRESS_LABELS[progress] || "";
      progressNode.hidden = !PROGRESS_LABELS[progress];
      renderOfferVerification(fragment, offer);
      cards.append(fragment);
    }
    section.append(heading, cards);
    list.append(section);
  }

  empty.hidden = offers.length > 0;
}

function renderOfferVerification(fragment, offer) {
  const container = fragment.querySelector(".offer-verification");
  const result = state.verificationResults[offer.offer_id];
  if (!result) {
    container.hidden = true;
    return;
  }
  const meta = VERIFICATION_STATUS[result.status] || VERIFICATION_STATUS.verification_error;
  const badge = fragment.querySelector(".verification-badge");
  badge.textContent = meta.label;
  badge.className = `verification-badge is-${meta.tone}`;
  fragment.querySelector(".verification-detail").textContent = result.detail || meta.description;
  fragment.querySelector(".verification-time").textContent = result.checked_at
    ? `核验于 ${formatDate(result.checked_at, "Asia/Shanghai")}`
    : "";
  const refresh = fragment.querySelector(".verification-refresh");
  refresh.dataset.offerId = offer.offer_id;
  refresh.disabled = state.verificationBusy;
  container.hidden = false;
}

function setVerificationMessage(message, tone = "") {
  const node = document.querySelector("#verification-message");
  node.textContent = message || "";
  node.dataset.tone = tone;
}

function getVerificationOffers() {
  return selectVerificationOffers(state.offers, state.historyOffers);
}

function linkForPlatform(platform) {
  return state.verificationLinks.find((item) => item.platform === platform) || null;
}

function renderVerificationHub() {
  const client = state.verificationClient;
  const session = state.verificationSession;
  const disabled = client.mode === "disabled";
  const loginTest = client.mode === "login_test";
  const disabledNotice = document.querySelector("#verification-disabled");
  disabledNotice.hidden = !(disabled || loginTest);
  document.querySelector("#verification-disabled-reason").textContent = loginTest
    ? "当前只验收邮件登录回跳，不开放邮箱自助发送、游戏平台关联或游戏库核验。"
    : client.config?.reason
    || "账号后端完成配置前，继续使用下方批量确认助手。";
  document.querySelector("#verification-login").hidden = disabled || loginTest || Boolean(session);
  const emailFlow = client.config?.email_flow || "magic_link";
  document.querySelector("#verification-send-code").textContent = emailFlow === "otp" ? "发送验证码" : "发送登录链接";
  if (emailFlow === "magic_link") document.querySelector("#verification-code-row").hidden = true;
  document.querySelector("#verification-account").hidden = !session;
  document.querySelector("#verification-actions").hidden = !session || loginTest;
  document.querySelector("#verification-account-state").textContent = session
    ? "已登录"
    : loginTest ? "等待测试链接" : (disabled ? "尚未开放" : "未登录");
  document.querySelector("#verification-account-email").textContent = session?.email || "";

  const counts = summarizeVerificationResults(state.verificationResults);
  const hasResults = Object.keys(state.verificationResults).length > 0;
  document.querySelector("#verification-results-summary").hidden = !hasResults;
  document.querySelector("#verification-confirmed-count").textContent = String(counts.confirmed_owned);
  document.querySelector("#verification-likely-count").textContent = String(counts.likely_owned_activity);
  document.querySelector("#verification-undetected-count").textContent = String(counts.not_detected);
  document.querySelector("#verification-run").disabled = state.verificationBusy || !state.verificationLinks.length;
  renderVerificationPlatforms();
}

function renderVerificationPlatforms() {
  const container = document.querySelector("#verification-platforms");
  const template = document.querySelector("#verification-platform-template");
  container.replaceChildren();
  container.hidden = state.verificationClient.mode === "login_test";
  if (container.hidden) return;
  for (const capability of PLATFORM_CAPABILITIES) {
    const fragment = template.content.cloneNode(true);
    const link = linkForPlatform(capability.platform);
    fragment.querySelector(".verification-platform-name").textContent = capability.label;
    fragment.querySelector(".verification-platform-description").textContent = capability.description;
    const status = fragment.querySelector(".verification-platform-status");
    status.textContent = link ? `已关联${link.display_name ? ` · ${link.display_name}` : ""}` : platformStatusLabel(capability);
    status.classList.toggle("is-linked", Boolean(link));
    const button = fragment.querySelector(".verification-platform-button");
    const libraryLink = fragment.querySelector(".verification-library-link");
    if (capability.libraryUrl) {
      libraryLink.href = capability.libraryUrl;
      libraryLink.hidden = false;
    }
    if (link) {
      button.textContent = "解除关联";
      button.dataset.action = "unlink";
      button.dataset.platform = capability.platform;
      button.disabled = state.verificationBusy;
    } else if (capability.capability === "official_library") {
      button.textContent = state.verificationClient.mode === "disabled"
        ? "尚未开放"
        : state.verificationSession ? "关联账号" : "登录后关联";
      button.dataset.action = "link";
      button.dataset.platform = capability.platform;
      button.disabled = !state.verificationSession || state.verificationBusy;
    } else {
      button.hidden = true;
    }
    container.append(fragment);
  }
}

function platformStatusLabel(capability) {
  if (state.verificationClient.mode === "disabled" && capability.capability === "official_library") return "等待后端上线";
  if (capability.capability === "official_library") return "可关联核验";
  if (capability.capability === "public_activity_gate") return "公开数据源待验收";
  return "暂无法核验";
}

async function refreshVerificationAccount() {
  state.verificationSession = state.verificationClient.getSession();
  if (!state.verificationSession) {
    state.verificationLinks = [];
    state.verificationResults = {};
    renderVerificationHub();
    render();
    return;
  }
  if (state.verificationClient.mode === "login_test") {
    state.verificationLinks = [];
    state.verificationResults = {};
    renderVerificationHub();
    render();
    return;
  }
  const [links, results] = await Promise.all([
    state.verificationClient.listLinks(),
    state.verificationClient.listResults(),
  ]);
  state.verificationLinks = links.map(sanitizeLink).filter(Boolean);
  state.verificationResults = indexVerificationResults(results);
  renderVerificationHub();
  render();
}

function bindVerification() {
  document.querySelector("#verification-send-code").addEventListener("click", async () => {
    const email = document.querySelector("#verification-email").value.trim();
    await withVerificationBusy(async () => {
      const response = await state.verificationClient.requestCode(email);
      const expectsCode = Boolean(response.demo_code) || response.delivery === "otp";
      document.querySelector("#verification-code-row").hidden = !expectsCode;
      setVerificationMessage(response.demo_code
        ? `本地演示验证码：${response.demo_code}`
        : expectsCode
          ? "验证码已发送，请检查邮箱。"
          : "登录链接已发送，请在当前设备打开邮件中的链接。", "success");
      if (expectsCode) document.querySelector("#verification-code").focus();
    });
  });

  document.querySelector("#verification-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.querySelector("#verification-email").value.trim();
    const code = document.querySelector("#verification-code").value.trim();
    await withVerificationBusy(async () => {
      await state.verificationClient.verifyCode(email, code);
      setVerificationMessage("登录成功，可以关联游戏平台。", "success");
      await refreshVerificationAccount();
    });
  });

  document.querySelector("#verification-sign-out").addEventListener("click", async () => {
    await withVerificationBusy(async () => {
      await state.verificationClient.logout();
      setVerificationMessage("已退出登录。", "success");
      await refreshVerificationAccount();
    });
  });

  document.querySelector("#verification-platforms").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const platform = button.dataset.platform;
    await withVerificationBusy(async () => {
      if (button.dataset.action === "unlink") {
        await state.verificationClient.unlink(platform);
        setVerificationMessage("平台关联已解除，相关核验结果已清除。", "success");
        await refreshVerificationAccount();
        return;
      }
      const response = await state.verificationClient.startLink(platform);
      if (response.authorize_url) {
        location.assign(response.authorize_url);
        return;
      }
      setVerificationMessage("平台账号已关联。", "success");
      await refreshVerificationAccount();
    });
  });

  document.querySelector("#verification-run").addEventListener("click", async () => {
    await runVerificationAndRefresh();
  });

  document.querySelector("#offer-list").addEventListener("click", async (event) => {
    const button = event.target.closest(".verification-refresh");
    if (!button) return;
    await runVerificationAndRefresh(button.dataset.offerId);
  });

  document.querySelector("#verification-clear").addEventListener("click", async () => {
    await withVerificationBusy(async () => {
      await state.verificationClient.clearResults();
      state.verificationResults = {};
      setVerificationMessage("核验结果已清除，平台关联仍然保留。", "success");
      renderVerificationHub();
      render();
    });
  });

  document.querySelector("#verification-delete-account").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!state.verificationDeleteArmed) {
      state.verificationDeleteArmed = true;
      button.textContent = "再次点击确认删除";
      clearTimeout(state.verificationDeleteTimer);
      state.verificationDeleteTimer = setTimeout(() => {
        state.verificationDeleteArmed = false;
        button.textContent = "删除领取状态账号";
      }, 5000);
      return;
    }
    clearTimeout(state.verificationDeleteTimer);
    state.verificationDeleteArmed = false;
    await withVerificationBusy(async () => {
      await state.verificationClient.deleteAccount();
      button.textContent = "删除领取状态账号";
      setVerificationMessage("领取状态账号、平台关联和核验结果已删除。", "success");
      await refreshVerificationAccount();
    });
  });
}

async function runVerificationAndRefresh(focusOfferId = null) {
  await withVerificationBusy(async () => {
    const results = await state.verificationClient.runVerification(getVerificationOffers());
    state.verificationResults = indexVerificationResults(results);
    const focus = focusOfferId ? state.verificationResults[focusOfferId] : null;
    const suffix = focus ? `当前活动状态：${VERIFICATION_STATUS[focus.status]?.label || "已更新"}。` : "";
    setVerificationMessage(`核验完成：已检查 ${Object.keys(state.verificationResults).length} 条限免记录。${suffix}`, "success");
    await refreshVerificationAccount();
  });
}

async function withVerificationBusy(action) {
  if (state.verificationBusy) return;
  state.verificationBusy = true;
  renderVerificationHub();
  try {
    await action();
  } catch (error) {
    setVerificationMessage(error.message || "操作没有完成，请稍后重试。", "error");
  } finally {
    state.verificationBusy = false;
    renderVerificationHub();
  }
}

async function initializeVerification() {
  let authCompleted = false;
  try {
    authCompleted = Boolean(state.verificationClient.acceptAuthCallback?.());
    if (authCompleted) history.replaceState(null, "", `${location.pathname}${location.search}`);
  } catch (error) {
    setVerificationMessage(error.message || "邮件登录没有完成，请重新发送登录邮件。", "error");
  }
  state.verificationSession = state.verificationClient.getSession();
  renderVerificationHub();
  if (authCompleted) setVerificationMessage(
    state.verificationClient.mode === "login_test"
      ? "登录回跳测试成功。游戏平台关联和游戏库核验仍未开放。"
      : "登录成功，可以关联游戏平台。",
    "success",
  );
  const itchCallback = readItchOAuthFragment();
  if (itchCallback && state.verificationSession) {
    await withVerificationBusy(async () => {
      await state.verificationClient.completeItchLink(itchCallback);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      setVerificationMessage("itch.io 账号已关联。", "success");
    });
  }
  if (state.verificationSession) await withVerificationBusy(refreshVerificationAccount);
  const params = new URLSearchParams(location.search);
  if (params.get("verification") === "linked") {
    setVerificationMessage("平台账号已关联，请登录后查看核验状态。", "success");
  }
}

function renderMembershipSettings() {
  document.querySelectorAll("[data-membership-platform]").forEach((input) => {
    input.checked = state.queue.memberships[input.dataset.membershipPlatform] === true;
  });
}

function renderBatchAssistant() {
  const summary = summarizeQueue(state.offers, state.queue);
  document.querySelector("#batch-pending-count").textContent = String(summary.pending);
  document.querySelector("#batch-confirmed-count").textContent = String(summary.user_confirmed);
  document.querySelector("#batch-skipped-count").textContent = String(summary.skipped);
  document.querySelector("#batch-total-count").textContent = String(summary.total);
  document.querySelector("#membership-hidden").textContent = summary.hidden_membership
    ? `另有 ${summary.hidden_membership} 项会员会免未加入清单，可在下方开启对应会员。`
    : "会员设置只保存在当前浏览器。";
  const storageWarning = document.querySelector("#storage-warning");
  storageWarning.textContent = state.storageMessage;
  storageWarning.hidden = !state.storageMessage;
  renderMembershipSettings();

  const workflow = document.querySelector("#batch-workflow");
  workflow.hidden = !state.batchOpen;
  if (!state.batchOpen) return;

  const current = getNextPendingOffer(state.offers, state.queue);
  const activeView = document.querySelector("#batch-active");
  const completeView = document.querySelector("#batch-complete");
  activeView.hidden = !current;
  completeView.hidden = Boolean(current);
  if (!current) {
    document.querySelector("#complete-confirmed").textContent = String(summary.user_confirmed);
    document.querySelector("#complete-skipped").textContent = String(summary.skipped);
    return;
  }

  const completed = summary.user_confirmed + summary.skipped;
  document.querySelector("#batch-position").textContent = `第 ${completed + 1} / ${summary.total} 项`;
  document.querySelector("#batch-platform").textContent = current.platform_label || current.platform;
  document.querySelector("#batch-region").textContent = (current.regions || []).join(" / ");
  document.querySelector("#batch-title-current").textContent = current.title;
  document.querySelector("#batch-ownership").textContent = OWNERSHIP_LABELS[current.ownership] || current.ownership;
  document.querySelector("#batch-membership").textContent = current.membership_required ? "需要对应会员" : "无需会员";
  document.querySelector("#batch-deadline").textContent = formatDate(current.ends_at, current.timezone);
  const openLink = document.querySelector("#batch-open-link");
  openLink.href = current.official_url;
  openLink.dataset.offerId = current.offer_id;
  const openedAt = state.queue.progress[current.offer_id]?.opened_at;
  const confirm = document.querySelector("#batch-confirm");
  confirm.disabled = !openedAt;
  confirm.dataset.offerId = current.offer_id;
  document.querySelector("#batch-skip").dataset.offerId = current.offer_id;
  document.querySelector("#batch-confirm-hint").textContent = openedAt
    ? "请确认你已在官方页面完成操作，再记录本机进度。这里不会核验是否真正入库。"
    : "先打开官方页面，返回后才能记录为已确认。";
}

function bindFilters() {
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".filter").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      render();
    });
  });
}

function bindBatchAssistant() {
  document.querySelector("#batch-start").addEventListener("click", () => {
    state.batchOpen = true;
    renderBatchAssistant();
    document.querySelector("#batch-workflow").scrollIntoView({ block: "start" });
  });
  document.querySelector("#batch-close").addEventListener("click", () => {
    state.batchOpen = false;
    renderBatchAssistant();
  });
  document.querySelector("#batch-open-link").addEventListener("click", (event) => {
    const offerId = event.currentTarget.dataset.offerId;
    if (offerId) updateQueue(markOfferOpened(state.queue, offerId));
  });
  document.querySelector("#batch-confirm").addEventListener("click", (event) => {
    const offerId = event.currentTarget.dataset.offerId;
    if (!offerId) return;
    try {
      updateQueue(setOfferProgress(state.queue, offerId, "user_confirmed"));
    } catch (error) {
      state.storageMessage = error.message;
      renderBatchAssistant();
    }
  });
  document.querySelector("#batch-skip").addEventListener("click", (event) => {
    const offerId = event.currentTarget.dataset.offerId;
    if (offerId) updateQueue(setOfferProgress(state.queue, offerId, "skipped"));
  });
  document.querySelector("#batch-reset").addEventListener("click", () => {
    updateQueue(resetCurrentProgress(state.queue, state.offers));
    state.batchOpen = true;
    renderBatchAssistant();
  });
  document.querySelector("#batch-clear").addEventListener("click", (event) => {
    const clearButton = event.currentTarget;
    if (!state.clearArmed) {
      state.clearArmed = true;
      clearButton.textContent = "再次点击确认清除";
      clearTimeout(state.clearTimer);
      state.clearTimer = setTimeout(() => {
        state.clearArmed = false;
        clearButton.textContent = "清除本机记录";
      }, 5000);
      return;
    }
    clearTimeout(state.clearTimer);
    state.clearArmed = false;
    state.queue = syncQueueProgress(createDefaultQueueState(), state.offers);
    if (state.storagePersistent) localStorage.removeItem(STORAGE_KEY);
    clearButton.textContent = "清除本机记录";
    state.batchOpen = false;
    renderBatchAssistant();
    render();
  });
  document.querySelectorAll("[data-membership-platform]").forEach((input) => {
    input.addEventListener("change", () => {
      const next = sanitizeQueueState(state.queue);
      next.memberships[input.dataset.membershipPlatform] = input.checked;
      updateQueue(syncQueueProgress(next, state.offers));
    });
  });
}

async function loadOffers() {
  const [response, historyResponse] = await Promise.all([
    fetch("./offers.json", { cache: "no-store" }),
    fetch("./history.json", { cache: "no-store" }),
  ]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const historyPayload = historyResponse.ok ? await historyResponse.json() : { offers: [] };
  state.offers = Array.isArray(payload.offers) ? payload.offers : [];
  state.historyOffers = Array.isArray(historyPayload.offers) ? historyPayload.offers : [];
  state.offers.sort((a, b) => {
    const aEnd = a.ends_at ? new Date(a.ends_at).valueOf() : Number.POSITIVE_INFINITY;
    const bEnd = b.ends_at ? new Date(b.ends_at).valueOf() : Number.POSITIVE_INFINITY;
    return aEnd - bEnd || a.title.localeCompare(b.title, "zh-CN");
  });
  state.queue = syncQueueProgress(loadQueueState(), state.offers);
  saveQueueState();
  populatePlatforms();
  document.querySelector("#active-count").textContent = String(state.offers.length);
  document.querySelector("#updated-at").textContent = payload.generated_at
    ? `最近核验：${formatDate(payload.generated_at, "Asia/Shanghai")}`
    : "等待首次核验";
  const next = state.offers.find((offer) => offer.ends_at);
  document.querySelector("#next-deadline").textContent = next
    ? `最近一项将在 ${formatDate(next.ends_at, next.timezone)} 结束`
    : "暂无明确临期活动";
  renderBatchAssistant();
  render();
}

bindFilters();
bindPlatformFilter();
bindBatchAssistant();
bindVerification();
loadOffers()
  .then(initializeVerification)
  .catch(() => {
    document.querySelector("#next-deadline").textContent = "数据暂时不可用，请稍后再看";
    renderBatchAssistant();
    renderVerificationHub();
    render();
  });

setInterval(() => {
  renderBatchAssistant();
  render();
}, 60000);
