// api/mwork-proxy.js
const PLANNER_ID = "69aea462646ef8fbf8ebd9ee";
const COMPANY_ID = "693042e16ec252fe0f990934";

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

  // 1. getPlannerData
  const plannerUrl =
    `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData` +
    `?mode=${mode}&date=${date}&companyId=${COMPANY_ID}&timezone=Europe%2FParis&granularity=60`;

  const plannerResp = await fetch(plannerUrl, { headers });
  if (plannerResp.status === 401 || plannerResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!plannerResp.ok)
    return res.status(plannerResp.status).json({ error: `Erreur m-work planner : ${plannerResp.status}` });

  const plannerData = await plannerResp.json();

  // 2. time_off_request
  let timeOffRequests = [];
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
  } catch (e) {}

  // 3. Catalogue d'activités — chercher tous les objets avec id+name+externalId
  // Approche : parser le JSON et chercher récursivement les objets activité
  const activityCatalog = {};
  try {
    const findActivities = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(findActivities); return; }
      // Un objet "activité" a id (24 hex), name, color, externalId
      if (
        typeof obj.id === "string" && obj.id.length === 24 &&
        typeof obj.name === "string" && obj.name.length > 0 &&
        typeof obj.externalId === "string" && obj.externalId.length > 0 &&
        typeof obj.color === "string"
      ) {
        activityCatalog[obj.id] = {
          name: obj.name,
          color: obj.color,
          code: obj.externalId,
        };
      }
      Object.values(obj).forEach(findActivities);
    };
    findActivities(plannerData);
  } catch (e) {
    console.error("activity catalog error:", e);
  }

  plannerData.timeOffRequestList = timeOffRequests;
  plannerData.activityCatalog = activityCatalog;

  return res.status(200).json(plannerData);
};
