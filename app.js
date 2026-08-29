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

const GROUPS = [
  ["keep", "永久入库"],
  ["subscription", "会员可领"],
  ["free_weekend", "限时畅玩"],
  ["trial", "新试玩与常驻免费"],
];

const state = { offers: [], filter: "all", platform: "all" };

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
      cards.append(fragment);
    }
    section.append(heading, cards);
    list.append(section);
  }

  empty.hidden = offers.length > 0;
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
  populatePlatforms();
  document.querySelector("#active-count").textContent = String(state.offers.length);
  document.querySelector("#updated-at").textContent = payload.generated_at
    ? `最近核验：${formatDate(payload.generated_at, "Asia/Shanghai")}`
    : "等待首次核验";
  const next = state.offers.find((offer) => offer.ends_at);
  document.querySelector("#next-deadline").textContent = next
    ? `最近一项将在 ${formatDate(next.ends_at, next.timezone)} 结束`
    : "暂无明确临期活动";
  render();
}

bindFilters();
bindPlatformFilter();
loadOffers().catch(() => {
  document.querySelector("#next-deadline").textContent = "数据暂时不可用，请稍后再看";
  render();
});

setInterval(() => render(), 60000);
