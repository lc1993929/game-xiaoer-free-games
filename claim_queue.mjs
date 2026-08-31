export const STORAGE_KEY = "game_xiaoer_claim_queue_v1";
export const STORAGE_VERSION = 1;

export const MEMBERSHIP_PLATFORMS = [
  { platform: "prime_gaming", label: "Prime Gaming" },
  { platform: "ps_plus_hk", label: "PlayStation Plus 港区" },
  { platform: "xbox_free_play_days_hk", label: "Xbox 会员港区" },
  { platform: "nintendo_switch_online_hk", label: "Nintendo Switch Online 港区" },
];

const PROGRESS_STATUSES = new Set(["pending", "user_confirmed", "skipped"]);
const CLAIMABLE_TYPES = new Set(["keep", "subscription"]);
const PUBLISHABLE_STATUSES = new Set(["verified", "published"]);

export function createDefaultQueueState() {
  return {
    version: STORAGE_VERSION,
    memberships: Object.fromEntries(MEMBERSHIP_PLATFORMS.map(({ platform }) => [platform, false])),
    progress: {},
  };
}

function validIso(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf()) ? value : null;
}

export function sanitizeQueueState(value) {
  const clean = createDefaultQueueState();
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== STORAGE_VERSION) return clean;

  for (const { platform } of MEMBERSHIP_PLATFORMS) {
    clean.memberships[platform] = value.memberships?.[platform] === true;
  }

  if (value.progress && typeof value.progress === "object" && !Array.isArray(value.progress)) {
    for (const [offerId, item] of Object.entries(value.progress)) {
      if (!offerId || !item || typeof item !== "object" || !PROGRESS_STATUSES.has(item.status)) continue;
      clean.progress[offerId] = {
        status: item.status,
        opened_at: validIso(item.opened_at),
        updated_at: validIso(item.updated_at),
      };
    }
  }
  return clean;
}

export function isClaimableOffer(offer, now = new Date()) {
  if (!offer || !offer.offer_id || !CLAIMABLE_TYPES.has(offer.offer_type)) return false;
  if ("status" in offer && !PUBLISHABLE_STATUSES.has(offer.status)) return false;
  if (offer.current_price?.amount !== 0) return false;
  if (offer.starts_at && new Date(offer.starts_at) > now) return false;
  if (!offer.ends_at || new Date(offer.ends_at) <= now) return false;
  if (!Array.isArray(offer.regions) || offer.regions.length === 0) return false;
  if (offer.offer_type === "subscription" && offer.membership_required !== true) return false;
  if (offer.offer_type === "keep" && offer.membership_required !== false) return false;
  try {
    return new URL(offer.official_url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sortQueueOffers(offers) {
  return [...offers].sort((a, b) => {
    const endDiff = new Date(a.ends_at).valueOf() - new Date(b.ends_at).valueOf();
    if (endDiff) return endDiff;
    const typeDiff = Number(a.offer_type === "subscription") - Number(b.offer_type === "subscription");
    return typeDiff || a.title.localeCompare(b.title, "zh-CN");
  });
}

export function getClaimableOffers(offers, now = new Date()) {
  return sortQueueOffers((offers || []).filter((offer) => isClaimableOffer(offer, now)));
}

export function getQueueOffers(offers, queueState, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  return getClaimableOffers(offers, now).filter((offer) =>
    offer.offer_type === "keep" || state.memberships[offer.platform] === true,
  );
}

export function syncQueueProgress(queueState, offers, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  const timestamp = now.toISOString();
  for (const offer of getClaimableOffers(offers, now)) {
    if (!state.progress[offer.offer_id]) {
      state.progress[offer.offer_id] = { status: "pending", opened_at: null, updated_at: timestamp };
    }
  }
  for (const [offerId, item] of Object.entries(state.progress)) {
    const updatedAt = validIso(item.updated_at);
    if (!offers.some((offer) => offer.offer_id === offerId) && updatedAt && now - new Date(updatedAt) > 30 * 86400000) {
      delete state.progress[offerId];
    }
  }
  return state;
}

export function summarizeQueue(offers, queueState, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  const queue = getQueueOffers(offers, state, now);
  const counts = { total: queue.length, pending: 0, user_confirmed: 0, skipped: 0 };
  for (const offer of queue) {
    const status = state.progress[offer.offer_id]?.status || "pending";
    counts[PROGRESS_STATUSES.has(status) ? status : "pending"] += 1;
  }
  const hiddenMembership = getClaimableOffers(offers, now).filter((offer) =>
    offer.offer_type === "subscription" && state.memberships[offer.platform] !== true,
  ).length;
  return { ...counts, hidden_membership: hiddenMembership };
}

export function getNextPendingOffer(offers, queueState, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  return getQueueOffers(offers, state, now).find((offer) =>
    (state.progress[offer.offer_id]?.status || "pending") === "pending",
  ) || null;
}

export function markOfferOpened(queueState, offerId, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  const previous = state.progress[offerId] || { status: "pending", opened_at: null, updated_at: null };
  state.progress[offerId] = { ...previous, opened_at: now.toISOString(), updated_at: now.toISOString() };
  return state;
}

export function setOfferProgress(queueState, offerId, status, now = new Date()) {
  if (!PROGRESS_STATUSES.has(status)) throw new Error(`不支持的进度状态：${status}`);
  const state = sanitizeQueueState(queueState);
  const previous = state.progress[offerId] || { status: "pending", opened_at: null, updated_at: null };
  if (status === "user_confirmed" && !previous.opened_at) throw new Error("必须先打开官方页面才能确认");
  state.progress[offerId] = { ...previous, status, updated_at: now.toISOString() };
  return state;
}

export function resetCurrentProgress(queueState, offers, now = new Date()) {
  const state = sanitizeQueueState(queueState);
  const timestamp = now.toISOString();
  for (const offer of getQueueOffers(offers, state, now)) {
    state.progress[offer.offer_id] = { status: "pending", opened_at: null, updated_at: timestamp };
  }
  return state;
}
