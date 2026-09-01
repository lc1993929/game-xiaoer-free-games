export const VERIFICATION_STATUS = Object.freeze({
  confirmed_owned: {
    label: "确认在库",
    tone: "confirmed",
    description: "官方游戏库或权益接口确认当前账号拥有这款游戏。",
  },
  likely_owned_activity: {
    label: "推定已拥有",
    tone: "likely",
    description: "发现奖杯、成就或游玩记录；可能来自订阅、试玩、共享或历史访问。",
  },
  not_detected: {
    label: "未检测到",
    tone: "neutral",
    description: "本次没有发现匹配记录，不等于没有领取。",
  },
  privacy_blocked: {
    label: "隐私受限",
    tone: "blocked",
    description: "平台隐私设置阻止了游戏库或活动记录读取。",
  },
  unsupported: {
    label: "暂无法核验",
    tone: "unsupported",
    description: "平台暂未提供可安全使用的完整游戏库读取能力。",
  },
  verification_error: {
    label: "核验失败",
    tone: "error",
    description: "本次核验没有完成，请稍后手动重试。",
  },
});

export const PLATFORM_CAPABILITIES = Object.freeze([
  {
    platform: "steam_cn",
    label: "Steam 国区",
    capability: "unsupported",
    linkMethod: null,
    resultLevel: "unsupported",
    description: "当前没有可用的服务端 Web API Key，首版暂不开放自动核验。",
    libraryUrl: "https://store.steampowered.com/account/",
  },
  {
    platform: "itch_io",
    label: "itch.io",
    capability: "official_library",
    linkMethod: "oauth",
    resultLevel: "confirmed",
    description: "使用 itch.io 官方授权读取已购买或领取内容。",
  },
  {
    platform: "ps_plus_hk",
    label: "PlayStation 港区",
    capability: "public_activity_gate",
    linkMethod: "public_profile",
    resultLevel: "likely",
    description: "只有公开奖杯数据源通过访问规则验收后才会启用。",
  },
  {
    platform: "xbox_free_play_days_hk",
    label: "Xbox 港区",
    capability: "public_activity_gate",
    linkMethod: "public_profile",
    resultLevel: "likely",
    description: "只有公开成就数据源通过访问规则验收后才会启用。",
  },
  {
    platform: "gog",
    label: "GOG",
    capability: "public_activity_gate",
    linkMethod: "public_profile",
    resultLevel: "likely",
    description: "只有公开活动数据源通过访问规则验收后才会启用。",
  },
  {
    platform: "epic",
    label: "Epic Games Store",
    capability: "unsupported",
    linkMethod: null,
    resultLevel: "unsupported",
    description: "普通 Epic 授权不开放完整消费者游戏库。",
    libraryUrl: "https://store.epicgames.com/library",
  },
  {
    platform: "prime_gaming",
    label: "Prime Gaming",
    capability: "unsupported",
    linkMethod: null,
    resultLevel: "unsupported",
    description: "Login with Amazon 只提供身份资料，不提供完整领取记录。",
    libraryUrl: "https://gaming.amazon.com/my-collection",
  },
  {
    platform: "nintendo_switch_online_hk",
    label: "Nintendo Switch 港区",
    capability: "unsupported",
    linkMethod: null,
    resultLevel: "unsupported",
    description: "不读取任天堂账号会话；请在主机 Nintendo eShop 中检查。",
    libraryUrl: "https://ec.nintendo.com/my/",
  },
]);

const STATUS_KEYS = new Set(Object.keys(VERIFICATION_STATUS));
const PLATFORM_KEYS = new Set(PLATFORM_CAPABILITIES.map((item) => item.platform));
const CATALOG_FIELDS = Object.freeze({
  steam_cn: "steam_appid",
  itch_io: "itch_game_id",
  ps_plus_hk: "psn_trophy_title_id",
  xbox_free_play_days_hk: "xbox_product_id",
  gog: "gog_product_id",
  epic: "epic_catalog_item_id",
  prime_gaming: "prime_offer_id",
  nintendo_switch_online_hk: "nintendo_title_id",
});

export function getPlatformCapability(platform) {
  return PLATFORM_CAPABILITIES.find((item) => item.platform === platform) || null;
}

export function getOfferCatalogId(offer) {
  if (!offer || typeof offer !== "object") return null;
  const field = CATALOG_FIELDS[offer.platform];
  const value = field ? offer.catalog_ids?.[field] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function exactCatalogMatch(offer, evidence) {
  if (!offer || !evidence || offer.platform !== evidence.platform) return false;
  const expected = getOfferCatalogId(offer);
  return Boolean(expected && expected === String(evidence.catalog_id || "").trim());
}

export function resultFromEvidence(offer, evidence) {
  if (!offer || !evidence || !exactCatalogMatch(offer, evidence)) {
    return { status: "not_detected", evidence_type: "none", access_type: "unknown" };
  }
  if (evidence.kind === "official_entitlement" || evidence.kind === "official_owned_library") {
    return {
      status: "confirmed_owned",
      evidence_type: evidence.kind,
      access_type: evidence.access_type || "unknown",
    };
  }
  if (["achievement", "trophy", "playtime"].includes(evidence.kind)) {
    return {
      status: "likely_owned_activity",
      evidence_type: evidence.kind,
      access_type: evidence.access_type || "unknown",
    };
  }
  return { status: "not_detected", evidence_type: "none", access_type: "unknown" };
}

export function sanitizeVerificationResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!value.offer_id || !PLATFORM_KEYS.has(value.platform) || !STATUS_KEYS.has(value.status)) return null;
  return {
    offer_id: String(value.offer_id),
    platform: String(value.platform),
    status: String(value.status),
    evidence_type: String(value.evidence_type || "none"),
    access_type: String(value.access_type || "unknown"),
    observed_at: validIso(value.observed_at),
    checked_at: validIso(value.checked_at),
    detail: typeof value.detail === "string" ? value.detail.slice(0, 240) : "",
  };
}

export function indexVerificationResults(values) {
  const result = {};
  for (const value of Array.isArray(values) ? values : []) {
    const clean = sanitizeVerificationResult(value);
    if (clean) result[clean.offer_id] = clean;
  }
  return result;
}

export function summarizeVerificationResults(values) {
  const counts = Object.fromEntries(Object.keys(VERIFICATION_STATUS).map((key) => [key, 0]));
  for (const value of Array.isArray(values) ? values : Object.values(values || {})) {
    const clean = sanitizeVerificationResult(value);
    if (clean) counts[clean.status] += 1;
  }
  return counts;
}

export function sanitizeLink(value) {
  if (!value || typeof value !== "object" || !PLATFORM_KEYS.has(value.platform)) return null;
  return {
    platform: String(value.platform),
    display_name: String(value.display_name || "").slice(0, 80),
    external_user_id: String(value.external_user_id || "").slice(0, 100),
    status: ["linked", "privacy_blocked", "revoked", "error"].includes(value.status) ? value.status : "error",
    linked_at: validIso(value.linked_at),
    last_checked_at: validIso(value.last_checked_at),
  };
}

export function selectVerificationOffers(activeOffers, historyOffers, now = new Date(), days = 90) {
  const threshold = now.valueOf() - days * 86400000;
  const selected = new Map();
  for (const offer of [...(activeOffers || []), ...(historyOffers || [])]) {
    if (!offer?.offer_id || !["verified", "published"].includes(offer.status)) continue;
    if (!["keep", "subscription"].includes(offer.offer_type)) continue;
    const end = offer.ends_at ? new Date(offer.ends_at).valueOf() : Number.POSITIVE_INFINITY;
    if (Number.isFinite(end) && end < threshold) continue;
    selected.set(offer.offer_id, offer);
  }
  return [...selected.values()];
}

function validIso(value) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).valueOf())) return null;
  return value;
}
