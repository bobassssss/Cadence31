// api/set-activity.js
// Route Vercel appelée par Make quand un mail "Nouvelle demande d'absence" est reçu
// Recherche le membre par nom, génère les dates, insère CP en AM+PM dans Supabase

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAKE_SECRET = process.env.MAKE_SECRET; // clé secrète à définir dans Vercel env vars

// Mois français → numéro
const MOIS_MAP = {
  janvier: "01", février: "02", fevrier: "02",
  mars: "03", avril: "04", mai: "05", juin: "06",
  juillet: "07", août: "08", aout: "08",
  septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
};

// Normalise une chaîne (accents, casse)
function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Parse "Mardi 5 mai" ou "5 mai" → "YYYY-MM-DD"
// Si le mois est déjà passé dans l'année en cours, prend l'année suivante
function parseDate(str) {
  if (!str) return null;
  const clean = norm(str.trim());
  // Chercher jour + mois dans la chaîne (ignore le nom du jour)
  const match = clean.match(/(\d{1,2})\s+([a-zéèêàùûîôç]+)/);
  if (!match) return null;
  const jour = match[1].padStart(2, "0");
  const moisStr = match[2];
  const moisNum = MOIS_MAP[moisStr];
  if (!moisNum) return null;
  const now = new Date();
  let year = now.getFullYear();
  // Si le mois est avant le mois actuel → année suivante
  if (parseInt(moisNum) < now.getMonth() + 1) year++;
  return `${year}-${moisNum}-${jour}`;
}

// Génère toutes les dates ouvrées (lun-sam) entre deux dates incluses
function genDates(dateDebut, dateFin) {
  const dates = [];
  const d = new Date(dateDebut);
  const fin = new Date(dateFin);
  while (d <= fin) {
    const dow = d.getDay();
    if (dow !== 0) { // pas dimanche
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const j = String(d.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${j}`);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Recherche floue du membre dans Supabase par nom
function findMember(members, searchName) {
  const sn = norm(searchName);
  let best = null, bestScore = 0;
  members.forEach(m => {
    const mn = norm(m.name);
    let score = 0;
    if (mn === sn) score = 10;
    else if (mn.includes(sn) || sn.includes(mn)) score = 5;
    else {
      const words = sn.split(" ");
      const common = words.filter(w => w.length > 2 && mn.includes(w)).length;
      score = common;
    }
    if (score > bestScore) { bestScore = score; best = m; }
  });
  return bestScore > 0 ? best : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-make-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Vérifier le secret Make
  const secret = req.headers["x-make-secret"];
  if (MAKE_SECRET && secret !== MAKE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { member_name, date_debut, date_fin, act = "CP" } = req.body;

  if (!member_name || !date_debut || !date_fin) {
    return res.status(400).json({ error: "member_name, date_debut et date_fin requis" });
  }

  // Parser les dates si elles arrivent en format français ("5 mai") ou ISO ("2026-05-05")
  const debut = date_debut.includes("-") ? date_debut : parseDate(date_debut);
  const fin = date_fin.includes("-") ? date_fin : parseDate(date_fin);

  if (!debut || !fin) {
    return res.status(400).json({ error: `Dates invalides : "${date_debut}" → "${date_fin}"` });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Récupérer tous les membres
  const { data: members, error: membErr } = await sb.from("members").select("id, name");
  if (membErr) return res.status(500).json({ error: membErr.message });

  // Trouver le membre
  const member = findMember(members, member_name);
  if (!member) {
    return res.status(404).json({ error: `Membre introuvable : "${member_name}"` });
  }

  // Générer les créneaux AM + PM pour chaque jour ouvré
  const dates = genDates(debut, fin);
  const rows = dates.flatMap(date => [
    { key: `${member.id}|${date}|AM`, act, comment: "", count_as: null },
    { key: `${member.id}|${date}|PM`, act, comment: "", count_as: null },
  ]);

  // Upsert dans Supabase
  const { error: upsertErr } = await sb.from("planning").upsert(rows, { onConflict: "key" });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  return res.status(200).json({
    ok: true,
    member: member.name,
    act,
    dates,
    slots: rows.length,
  });
}
