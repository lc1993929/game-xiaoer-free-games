export const CLAIM_RECORDS_STORAGE_KEY = "game_xiaoer_claim_records_v1";
export const CLAIM_RECORDS_VERSION = 1;

export function createClaimState() { return { version: CLAIM_RECORDS_VERSION, records: {} }; }

export function sanitizeClaimRecord(value) {
  if (!value || typeof value !== "object") return null;
  const offerId = String(value.offer_id || "").trim().slice(0, 240);
  const title = String(value.title || "").trim().slice(0, 200);
  const platform = String(value.platform || "").trim().slice(0, 80);
  const claimedAt = validIso(value.claimed_at);
  if (!offerId || !title || !platform || !claimedAt) return null;
  return { offer_id: offerId, title, platform, claimed_at: claimedAt, updated_at: validIso(value.updated_at) || claimedAt };
}

export function sanitizeClaimState(value) {
  const clean = createClaimState();
  if (!value || value.version !== CLAIM_RECORDS_VERSION || !value.records || typeof value.records !== "object") return clean;
  for (const item of Object.values(value.records)) {
    const record = sanitizeClaimRecord(item);
    if (record) clean.records[record.offer_id] = record;
  }
  return clean;
}

export function markClaimed(state, offer, now = new Date()) {
  const clean = sanitizeClaimState(state);
  const record = sanitizeClaimRecord({ offer_id: offer.offer_id, title: offer.title, platform: offer.platform, claimed_at: now.toISOString(), updated_at: now.toISOString() });
  if (!record) throw new Error("活动信息不完整，暂时无法记录");
  clean.records[record.offer_id] = record;
  return clean;
}

export function unmarkClaimed(state, offerId) {
  const clean = sanitizeClaimState(state);
  delete clean.records[String(offerId || "")];
  return clean;
}

export function mergeClaimRecords(localState, remoteRecords) {
  const merged = sanitizeClaimState(localState);
  for (const item of remoteRecords || []) {
    const record = sanitizeClaimRecord(item);
    if (!record) continue;
    const existing = merged.records[record.offer_id];
    if (!existing || new Date(record.updated_at) > new Date(existing.updated_at)) merged.records[record.offer_id] = record;
  }
  return merged;
}

export function listClaimRecords(state) {
  return Object.values(sanitizeClaimState(state).records).sort((a, b) => new Date(b.claimed_at) - new Date(a.claimed_at));
}

function validIso(value) { const date = new Date(String(value || "")); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
