// api/mwork-proxy.js
const PLANNER_ID = "69aed8d03f39552d4243bd38";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { cookie, date, mode = "month" } = req.body;
  if (!cookie || !date) return res.status(400).json({ error: "cookie et date requis" });

  const headers = {
    Cookie: cookie,
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  // Essayer getPlannerData d'abord, fallback sur user-planning
  let plannerData = null;
  let usedEndpoint = "";

  const urlOld = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData` +
    `?mode=${mode}&date=${date}&companyId=693042e16ec252fe0f990934&timezone=Europe%2FParis&granularity=60`;

  const urlNew = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  for (const [url, label] of [[urlOld, "getPlannerData"], [urlNew, "user-planning"]]) {
    const r = await fetch(url, { headers });
    if (r.status === 401 || r.status === 403)
      return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
    if (!r.ok) continue;
    plannerData = await r.json();
    usedEndpoint = label;
    break;
  }

  if (!plannerData)
    return res.status(502).json({ error: "Aucun endpoint m-work disponible" });

  // Normaliser : user-planning retourne {json:{users,viewConfig}, meta:{}}
  // On ramène tout au même format : {users, company, ...}
  if (plannerData.json && plannerData.json.users) {
    const inner = plannerData.json;
    plannerData = { ...inner, _meta: plannerData.meta, _endpoint: usedEndpoint };
  }

  // time_off_request
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) plannerData.timeOffRequestList = (await torResp.json()).timeOffRequestList || [];
  } catch (e) {}

  // Catalogue d'activités
  const catalog = {};
  const find = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(find); return; }
    if (typeof obj.id === "string" && obj.id.length === 24 &&
        typeof obj.name === "string" && obj.name.length > 0 &&
        typeof obj.color === "string") {
      catalog[obj.id] = { name: obj.name, color: obj.color, code: obj.externalId || obj.code || obj.name };
    }
    Object.values(obj).forEach(find);
  };
  find(plannerData);
  plannerData.activityCatalog = catalog;

  return res.status(200).json(plannerData);
};
