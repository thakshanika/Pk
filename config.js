// ============================================================
//  Nova — Configuration
//  මේ file එකේ ඔයාගේ API key/endpoint සහ Supabase details දාන්න.
// ============================================================

window.NOVA_CONFIG = {
  // ---- AI Provider: Codex-style custom REST API ----
  // POST { message, history, session, image_url } -> { reply } (non-streaming JSON)
  AI_ENDPOINT: "https://preview--code-x-ai.lovable.app/api/public/v1/chat",
  AI_API_KEY: "cx_live_4m311j5y6f1t5n0g191e0o5f163c173t",

  // ---- Supabase (conversation history persist කරන්න — optional) ----
  // හිස්ව තිබ්බොත් app එක localStorage එකට switch වෙනවා (Supabase නැතුවත් වැඩ කරයි).
  SUPABASE_URL: "",            // <-- https://xxxx.supabase.co
  SUPABASE_ANON_KEY: "",       // <-- Supabase anon public key

  // ---- General ----
  APP_NAME: "Nova",
};

