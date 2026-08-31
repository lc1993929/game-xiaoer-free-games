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
  filter: "all",
  platform: "all",
  queue: createDefaultQueueState(),
  storagePersistent: true,
  storageMessage: "",
  batchOpen: false,
  clearArmed: false,
  clearTimer: null,
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
      cards.append(fragment);
    }
    section.append(heading, cards);
    list.append(section);
  }

  empty.hidden = offers.length > 0;
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
  const response = await fetch("./offers.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  state.offers = Array.isArray(payload.offers) ? payload.offers : [];
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
loadOffers().catch(() => {
  document.querySelector("#next-deadline").textContent = "数据暂时不可用，请稍后再看";
  renderBatchAssistant();
  render();
});

setInterval(() => {
  renderBatchAssistant();
  render();
}, 60000);
