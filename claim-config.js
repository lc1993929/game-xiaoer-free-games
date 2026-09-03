window.GAME_XIAOER_CLAIM_CONFIG = {
  "schema_version": 1,
  "mode": "manual_claims",
  "email_flow": "otp",
  "reason": "不登录可在本机记录；邮箱登录仅用于跨设备同步手动领取记录。",
  "supabase_url": "https://btrexrewjapwhaqifyfn.supabase.co",
  "supabase_anon_key": "sb_publishable_HtC0xKAHQsc3C-gWQuINew_-oDa1gDj",
  "function_name": "claim-records-api",
  "auth_email_gate_function_name": "auth-email-gate",
  "cross_border": {
    "required": true,
    "receiver_name": "Supabase, Inc.",
    "destination": "韩国首尔",
    "data_categories": [
      "邮箱登录账号",
      "用户手动标记的领取记录"
    ],
    "consent_version": "2026-09-04-manual-v1"
  }
};
