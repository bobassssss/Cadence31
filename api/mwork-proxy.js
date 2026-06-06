// api/mwork-proxy.js
const PLANNER_ID = "69aed8d03f39552d4243bd38";
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

  // 1. Bootstrap — noms, locations, mainLocationId
  const userNames = {};
  const bsLocations = {};
  const bsMainLoc = {};

  try {
    const bsResp = await fetch(
      `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/bootstrap?companyId=${COMPANY_ID}`,
      { headers }
    );
    if (bsResp.ok) {
      const bs = await bsResp.json();
      const scan = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(scan); return; }
        // Membres
        const uid = obj._id || obj.id || obj.userId;
        const fn = obj.firstName || obj.firstname;
        const ln = obj.lastName || obj.lastname;
        if (uid && (fn || ln)) userNames[uid] = { firstName: fn||"", lastName: ln||"" };
        // Locations
        if (uid && obj.name && (obj.address !== undefined || obj.locationType !== undefined))
          bsLocations[uid] = obj.name;
        // mainLocationId par user
        if (uid && obj.mainLocationId) bsMainLoc[uid] = obj.mainLocationId;
        Object.values(obj).forEach(scan);
      };
      scan(bs);
    }
  } catch(e) { console.error("Bootstrap error:", e.message); }

  // 2. user-planning — users avec scheduledShifts déjà imbriqués
  const urlNew = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  const newResp = await fetch(urlNew, { headers });
  if (newResp.status === 401 || newResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!newResp.ok)
    return res.status(newResp.status).json({ error: `Erreur m-work : ${newResp.status}` });

  const newData = await newResp.json();
  const rawUsers = newData.json?.users || [];

  // 3. Enrichir chaque user avec nom + mainLocationId depuis bootstrap
  const users = rawUsers.map(u => {
    const uid = u.userId;
    const name = userNames[uid] || {};
    return {
      ...u,
      id: uid,
      _id: uid,
      firstName: name.firstName || u.firstName || "",
      lastName: name.lastName || u.lastName || "",
      mainLocationId: bsMainLoc[uid] || u.mainLocationId || "",
      activities: u.activities || [],
    };
  });

  // 4. time_off_request
  let timeOffRequests = [];
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
  } catch(e) {}

  // 5. Catalogue d'activités
  const activityCatalog = buildCatalog(newData);

  return res.status(200).json({
    users,
    company: {
      ...newData.json?.viewConfig,
      locations: Object.entries(bsLocations).map(([id, name]) => ({ id, name })),
    },
    timeOffRequestList: timeOffRequests,
    activityCatalog,
  });
};

function buildCatalog(data) {
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
  find(data);
  return catalog;
}
