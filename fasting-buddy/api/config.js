// Exposes public (client-safe) config so no keys are hard-coded in the bundle.
// The Supabase anon key is designed to be public; Row Level Security protects data.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
};
