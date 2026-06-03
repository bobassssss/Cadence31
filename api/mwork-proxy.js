// api/mwork-proxy.js — PLANNER_ID résolu dynamiquement

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

  // 1. Récupérer le PLANNER_ID dynamiquement
  let plannerId;
  try {
    const plannersResp = await fetch("https://app.m-work.co/v2/api/planners", { headers });
    if (plannersResp.status === 401 || plannersResp.status === 403)
      return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
    if (!plannersResp.ok)
      return res.status(plannersResp.status).json({ error: `Erreur m-work planners : ${plannersResp.status}` });
    const plannersData = await plannersResp.json();
    // Prendre le premier planner disponible
    const planners = plannersData.planners || plannersData.plannerList || plannersData;
    if (Array.isArray(planners) && planners.length > 0) {
      plannerId = planners[0].id || planners[0]._id;
    } else if (typeof planners === "object") {
      plannerId = Object.keys(planners)[0];
    }
    if (!plannerId) return res.status(500).json({ error: "Aucun planner trouvé" });
  } catch (e) {
    return res.status(500).json({ error: "Erreur récupération planners : " + e.message });
  }

  // 2. user-planning avec l'ID récupéré
  const plannerUrl =
    `https://app.m-work.co/v2/api/planner/${plannerId}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  const plannerResp = await fetch(plannerUrl, { headers });
  if (plannerResp.status === 401 || plannerResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!plannerResp.ok)
    return res.status(plannerResp.status).json({ error: `Erreur m-work planner : ${plannerResp.status}` });

  const plannerData = await plannerResp.json();

  // 3. time_off_request
  let timeOffRequests = [];
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
  } catch (e) {}

  // 4. Catalogue d'activités — parser récursivement
  const activityCatalog = {};
  try {
    const findActivities = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(findActivities); return; }
      if (
        typeof obj.id === "string" && obj.id.length === 24 &&
        typeof obj.name === "string" && obj.name.length > 0 &&
        typeof obj.color === "string"
      ) {
        activityCatalog[obj.id] = {
          name: obj.name,
          color: obj.color,
          code: obj.externalId || obj.code || obj.name,
        };
      }
      Object.values(obj).forEach(findActivities);
    };
    findActivities(plannerData);
  } catch (e) {}

  plannerData.timeOffRequestList = timeOffRequests;
  plannerData.activityCatalog = activityCatalog;
  plannerData._plannerId = plannerId; // debug

  return res.status(200).json(plannerData);
};
