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

  // Vérifier si le compte existe déjà
  const { data: { users }, error: listErr } = await sb.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });

  const existing = users.find(u => u.email === email);

  if (existing) {
    // Lever le ban si nécessaire
    if (existing.banned_until) {
      await sb.auth.admin.updateUserById(existing.id, { ban_duration: "none" });
    }
    // Envoyer un lien de réinitialisation de mot de passe
    const { error: resetErr } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: "https://cadence31.vercel.app",
    });
    if (resetErr) return res.status(400).json({ error: resetErr.message });
    return res.status(200).json({ ok: true, existing: true, reset: true });
  }

  // Nouveau compte → envoyer l'invitation
  const { error } = await sb.auth.admin.inviteUserByEmail(email, {
    data: { name: name || "" },
  });

  if (error) return res.status(400).json({ error: error.message });

  return res.status(200).json({ ok: true, existing: false });
};
