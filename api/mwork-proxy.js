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
    Cookie: cookie, Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };

  // 1. Bootstrap — noms membres + locations + catalogue activités
  const userNames = {}, activityCatalog = {};
  let bsRaw = null;
  try {
    const bsResp = await fetch(
      `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/bootstrap?companyId=${COMPANY_ID}`,
      { headers }
    );
    if (bsResp.ok) {
      bsRaw = await bsResp.json();
      const scan = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(scan); return; }
        const id = obj._id || obj.id;
        // Membres
        const fn = obj.firstName || obj.firstname;
        const ln = obj.lastName || obj.lastname;
        if (id && (fn || ln)) userNames[id] = { firstName: fn||"", lastName: ln||"" };
        // Catalogue activités
        if (id && obj.name && (obj.externalId || obj.color)) {
          activityCatalog[id] = {
            name: obj.name,
            code: obj.externalId || obj.code || obj.name,
            color: obj.color || "#888888",
          };
        }
        Object.values(obj).forEach(scan);
      };
      scan(bsRaw);
    }
  } catch(e) { console.error("Bootstrap:", e.message); }

  // 2. Locations via endpoint dédié (fallback sur bootstrap)
  const locationNames = {};
  for (const url of [
    `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/locations`,
    `https://app.m-work.co/v2/api/location?companyId=${COMPANY_ID}`,
    `https://app.m-work.co/v2/api/locations?companyId=${COMPANY_ID}`,
  ]) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) {
        const d = await r.json();
        const scan = (obj) => {
          if (!obj || typeof obj !== "object") return;
          if (Array.isArray(obj)) { obj.forEach(scan); return; }
          const id = obj._id || obj.id;
          if (id && obj.name && typeof obj.name === "string" && obj.name.length > 0) {
            locationNames[id] = obj.name;
          }
          Object.values(obj).forEach(scan);
        };
        scan(d);
        if (Object.keys(locationNames).length > 0) break;
      }
    } catch(e) {}
  }
  // Fallback : scanner le bootstrap pour les locations
  if (Object.keys(locationNames).length === 0 && bsRaw) {
    const scan = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(scan); return; }
      const id = obj._id || obj.id;
      if (id && obj.name && !obj.firstName && !obj.lastName) {
        locationNames[id] = obj.name;
      }
      Object.values(obj).forEach(scan);
    };
    scan(bsRaw);
  }
  console.log(`Locations trouvées: ${Object.keys(locationNames).length}`);

  // 3. user-planning
  const urlNew = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  const newResp = await fetch(urlNew, { headers });
  if (newResp.status === 401 || newResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!newResp.ok)
    return res.status(newResp.status).json({ error: `Erreur m-work : ${newResp.status}` });

  const newData = await newResp.json();
  const rawUsers = newData.json?.users || [];

  // 4. Enrichir users — noms + mainLocationId (location la plus fréquente dans ses shifts)
  const users = rawUsers.map(u => {
    const uid = u.userId;
    const name = userNames[uid] || {};

    // mainLocationId = locationId le plus fréquent dans les shifts "office" de cet user
    const locCounts = {};
    (u.scheduledShifts||[]).forEach(s => {
      if (s.type === "office" && s.locationId) {
        locCounts[s.locationId] = (locCounts[s.locationId]||0) + 1;
      }
    });
    const mainLocationId = Object.entries(locCounts)
      .sort((a,b) => b[1]-a[1])[0]?.[0] || "";

    return {
      ...u,
      id: uid, _id: uid,
      firstName: name.firstName || "",
      lastName: name.lastName || "",
      mainLocationId,
      scheduledShifts: u.scheduledShifts || [],
      activities: u.activities || [],
      draftActivities: u.draftActivities || [],
    };
  });

  // 5. time_off_request
  let timeOffRequests = [];
  try {
    const r = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (r.ok) timeOffRequests = (await r.json()).timeOffRequestList || [];
  } catch(e) {}

  return res.status(200).json({
    users,
    company: {
      locations: Object.entries(locationNames).map(([id, name]) => ({ id, name })),
    },
    timeOffRequestList: timeOffRequests,
    activityCatalog,
  });
};
