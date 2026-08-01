// Hands the browser the two public Supabase values it needs to build an auth
// client. The anon key is publishable by design — it grants nothing on its own
// because every table is behind RLS — but it lives in a server env var, so the
// client has to ask for it rather than have it hard-coded in index.html.
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
};
