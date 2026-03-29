// api/set-activity.js
// Reçoit subject + body HTML depuis Make, extrait nom et dates, insère CP dans Supabase

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAKE_SECRET = process.env.MAKE_SECRET;

// Mois français → numéro
const MOIS_MAP = {
  janvier:"01", février:"02", fevrier:"02",
  mars:"03", avril:"04", mai:"05", juin:"06",
  juillet:"07", août:"08", aout:"08",
  septembre:"09", octobre:"10", novembre:"11", décembre:"12", decembre:"12",
};

// Normalise une chaîne (accents, casse)
function norm(s) {
  return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}

// Extrait le texte brut depuis un HTML (supprime les balises, décode les entités)
function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, " ")        // supprimer balises
    .replace(/&nbsp;/g, " ")          // espace insécable
    .replace(/&rarr;/g, "→")          // flèche
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")             // espaces multiples
    .trim();
}

// Extrait le nom depuis le sujet "Nouvelle demande d'absence - Prénom Nom"
function extractName(subject) {
  const match = subject.match(/Nouvelle demande d['']absence\s*-\s*(.+)/i);
  return match ? match[1].trim() : null;
}

// Extrait les dates depuis le texte brut
// Format attendu : "Dates : Mardi 5 mai → Mercredi 6 mai"
function extractDates(text) {
  // Nettoyer et normaliser
  const t = norm(text);
  // Pattern : chercher "dates" puis deux occurrences de "chiffre + mois"
  const pattern = /dates\s*:?\s*(?:\w+\s+)?(\d{1,2})\s+([a-zéèêàùûîôç]+)(?:\s|.{0,30}?)(?:\w+\s+)?(\d{1,2})\s+([a-zéèêàùûîôç]+)/;
  const match = t.match(pattern);
  if (!match) return null;

  const [, jourDeb, moisDeb, jourFin, moisFin] = match;
  const moisDebNum = MOIS_MAP[moisDeb];
  const moisFinNum = MOIS_MAP[moisFin];
  if (!moisDebNum || !moisFinNum) return null;

  const now = new Date();
  let year = now.getFullYear();

  // Si le mois de début est déjà passé → année suivante
  const moisDebInt = parseInt(moisDebNum);
  if (moisDebInt < now.getMonth() + 1) year++;

  const debut = `${year}-${moisDebNum}-${jourDeb.padStart(2,"0")}`;
  // Gérer le cas où fin est l'année suivante (ex: déc → jan)
  const moisFinInt = parseInt(moisFinNum);
  let yearFin = year;
  if (moisFinInt < moisDebInt) yearFin++;
  const fin = `${yearFin}-${moisFinNum}-${jourFin.padStart(2,"0")}`;

  return { debut, fin };
}

// Génère toutes les dates ouvrées (lun-sam) entre deux dates incluses
function genDates(dateDebut, dateFin) {
  const dates = [];
  const d = new Date(dateDebut);
  const fin = new Date(dateFin);
  while (d <= fin) {
    if (d.getDay() !== 0) { // pas dimanche
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,"0");
      const j = String(d.getDate()).padStart(2,"0");
      dates.push(`${y}-${m}-${j}`);
    }
    d.setDate(d.getDate()+1);
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

  const { subject, body, act = "CP" } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: "subject et body requis" });
  }

  // Extraire le nom depuis le sujet
  const memberName = extractName(subject);
  if (!memberName) {
    return res.status(400).json({ error: `Impossible d'extraire le nom depuis : "${subject}"` });
  }

  // Convertir HTML en texte et extraire les dates
  const plainText = htmlToText(body);
  const dates = extractDates(plainText);
  if (!dates) {
    return res.status(400).json({
      error: "Impossible d'extraire les dates",
      text_sample: plainText.slice(0, 300),
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Récupérer tous les membres
  const { data: members, error: membErr } = await sb.from("members").select("id, name");
  if (membErr) return res.status(500).json({ error: membErr.message });

  // Trouver le membre
  const member = findMember(members, memberName);
  if (!member) {
    return res.status(404).json({ error: `Membre introuvable : "${memberName}"` });
  }

  // Générer les créneaux AM + PM pour chaque jour ouvré
  const workDates = genDates(dates.debut, dates.fin);
  const rows = workDates.flatMap(date => [
    { key: `${member.id}|${date}|AM`, act, comment: "", count_as: null },
    { key: `${member.id}|${date}|PM`, act, comment: "", count_as: null },
  ]);

  // Upsert dans Supabase
  const { error: upsertErr } = await sb
    .from("planning")
    .upsert(rows, { onConflict: "key" });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  return res.status(200).json({
    ok: true,
    member: member.name,
    act,
    debut: dates.debut,
    fin: dates.fin,
    jours: workDates.length,
    slots: rows.length,
  });
}
