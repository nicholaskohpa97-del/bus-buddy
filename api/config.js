const { applyCors } = require("./_auth");

// Hands the browser the public Supabase settings it needs to run Auth.
// The anon key is designed to be public — row access is enforced by RLS, not by
// hiding this value. The service-role key is never exposed here.
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;

  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
};
