// api/mwork-trigger.js
// Endpoint déclenché par MacroDroid avec le cookie m-work et la période souhaitée
// Sécurisé par un secret partagé

const PLANNER_ID = "69aea462646ef8fbf8ebd9ee";
const COMPANY_ID = "693042e16ec252fe0f990934";

const MONTHS_FR = {
  janvier:1, fevrier:2, février:2, mars:3, avril:4, mai:5, juin:6,
  juillet:7, aout:8, août:8, septembre:9, octobre:10, novembre:11, decembre:12, décembre:12
};

// Interprète le sujet du mail pour déterminer les mois à importer
function parsePeriod(subject) {
  const s = (subject || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // "2026" → année civile
  const yearMatch = s.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    return Array.from({length:12}, (_,i) => `${year}-${String(i+1).padStart(2,"0")}-01`);
  }

  const curYear = new Date().getFullYear();

  // "mars-juin" → plage de mois
  const rangeMatch = s.match(/([a-z]+)-([a-z]+)/);
  if (rangeMatch) {
    const m1 = MONTHS_FR[rangeMatch[1]];
    const m2 = MONTHS_FR[rangeMatch[2]];
    if (m1 && m2) {
      const dates = [];
      for (let m = m1; m <= m2; m++)
        dates.push(`${curYear}-${String(m).padStart(2,"0")}-01`);
      return dates;
    }
  }

  // "avril" → mois nommé
  for (const [name, num] of Object.entries(MONTHS_FR)) {
    if (s.includes(name))
      return [`${curYear}-${String(num).padStart(2,"0")}-01`];
  }

  // Par défaut → mois courant
  const now = new Date();
  return [`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`];
}

async function fetchPlannerMonth(date, cookie) {
  const url = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData`
    + `?mode=month&date=${date}&companyId=${COMPANY_ID}&timezone=Europe%2FParis&granularity=60`;
  const resp = await fetch(url, {
    headers: { Cookie: cookie, Accept: "*/*", "User-Agent": "Mozilla/5.0" }
  });
  if (!resp.ok) throw new Error(`m-work error ${resp.status} for ${date}`);
  return resp.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Vérification du secret
  const secret = (req.headers["authorization"] || "").replace("Bearer ", "");
  if (!process.env.MWORK_TRIGGER_SECRET || secret !== process.env.MWORK_TRIGGER_SECRET)
    return res.status(401).json({ error: "Non autorisé" });

  const { cookie, subject } = req.body;
  if (!cookie) return res.status(400).json({ error: "cookie manquant" });

  const months = parsePeriod(subject);

  try {
    // Récupérer les données pour chaque mois
    let mergedUsers = null;
    let baseData = null;
    let activityCatalog = {};

    for (let i = 0; i < months.length; i++) {
      const data = await fetchPlannerMonth(months[i], cookie);

      // Extraire le catalogue d'activités
      const findActivities = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(findActivities); return; }
        if (typeof obj.id === "string" && obj.id.length === 24 &&
            typeof obj.name === "string" && obj.externalId) {
          activityCatalog[obj.id] = { name: obj.name, color: obj.color || "", code: obj.externalId };
        }
        Object.values(obj).forEach(findActivities);
      };
      findActivities(data);

      if (!baseData) {
        baseData = data;
        mergedUsers = data.json.planner.users.map(u => ({
          ...u,
          scheduledShifts: [...u.scheduledShifts],
          activities: [...u.activities]
        }));
      } else {
        data.json.planner.users.forEach(mu => {
          const ex = mergedUsers.find(u => u.id === mu.id);
          if (ex) {
            ex.scheduledShifts.push(...mu.scheduledShifts);
            ex.activities.push(...mu.activities);
          }
        });
      }
    }

    // Récupérer les time_off_requests
    let timeOffRequests = [];
    try {
      const torResp = await fetch(
        `https://app.m-work.co/v2/api/time_off_request?scope=manager`,
        { headers: { Cookie: cookie, Accept: "*/*" } }
      );
      if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
    } catch(e) {}

    return res.status(200).json({
      success: true,
      months: months.length,
      users: mergedUsers.length,
      mergedUsers,
      activityCatalog,
      timeOffRequests,
      message: `Import prêt : ${months.length} mois, ${mergedUsers.length} collaborateurs`
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
