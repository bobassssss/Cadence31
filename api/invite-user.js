const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: "Email requis" });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data, error } = await sb.auth.admin.inviteUserByEmail(email, {
    data: { name: name || "" },
  });

  if (error) {
    if (error.message && error.message.toLowerCase().includes("already")) {
      return res.status(200).json({ ok: true, existing: true });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, existing: false });
};
