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

  // 1. Bootstrap — récupère les membres, lieux et mainLocationId
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
      // Chercher les membres récursivement
      const findMembers = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(findMembers); return; }
        // Un membre a firstName/lastname et un _id/id
        const uid = obj._id || obj.id || obj.userId;
        const fn = obj.firstName || obj.firstname;
        const ln = obj.lastName || obj.lastname;
        if (uid && (fn || ln)) {
          userNames[uid] = { firstName: fn || "", lastName: ln || "" };
        }
        Object.values(obj).forEach(findMembers);
      };
      findMembers(bs);
      console.log(`Bootstrap: ${Object.keys(userNames).length} membres trouvés`);
      
      // Extraire les locations et offTypes depuis bootstrap
      const findLocations = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(findLocations); return; }
        if (obj.id && obj.name && (obj.address !== undefined || obj.locationType !== undefined)) {
          bsLocations[obj.id] = obj.name;
        }
        Object.values(obj).forEach(findLocations);
      };
      findLocations(bs);
      
      // Stocker mainLocationId par userId
      const findMainLoc = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(findMainLoc); return; }
        const uid = obj._id || obj.id || obj.userId;
        if (uid && obj.mainLocationId) bsMainLoc[uid] = obj.mainLocationId;
        Object.values(obj).forEach(findMainLoc);
      };
      findMainLoc(bs);
    }
  } catch(e) {
    console.error("Bootstrap error:", e.message);
  }

  // 2. user-planning — shifts par userId
  const urlNew = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  const newResp = await fetch(urlNew, { headers });
  if (newResp.status === 401 || newResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!newResp.ok)
    return res.status(newResp.status).json({ error: `Erreur m-work : ${newResp.status}` });

  const newData = await newResp.json();
  const shifts = newData.json?.users || newData.users || [];

  // 3. Regrouper les shifts par userId
  const usersMap = {};
  shifts.forEach(shift => {
    const uid = shift.userId;
    if (!uid) return;
    if (!usersMap[uid]) {
      const name = userNames[uid] || {};
      usersMap[uid] = {
        id: uid, _id: uid,
        firstName: name.firstName || "",
        lastName: name.lastName || "",
        scheduledShifts: [],
        activities: [],
      };
    }
    usersMap[uid].scheduledShifts.push({
      planningDate: shift.planningDate,
      dayPart: shift.dayPart,
      type: shift.type,
      locationId: shift.locationId,
      startDate: shift.startDate,
      endDate: shift.endDate,
    });
  });

  // 4. Activités (accueil, GDV, MMC, leads...)
  try {
    const actUrl = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-activities` +
      `?mode=${mode}&date=${date}&timezone=Europe%2FParis`;
    const actResp = await fetch(actUrl, { headers });
    if (actResp.ok) {
      const actData = await actResp.json();
      (actData.json?.users || actData.users || []).forEach(a => {
        const uid = a.userId;
        if (uid && usersMap[uid]) {
          usersMap[uid].activities.push({
            activityId: a.activityId,
            startDate: a.startDate,
            endDate: a.endDate,
          });
        }
      });
    }
  } catch(e) {}

  // 5. time_off_request
  let timeOffRequests = [];
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
  } catch(e) {}

  // 6. Catalogue d'activités
  const activityCatalog = buildCatalog(newData);

  return res.status(200).json({
    users: Object.values(usersMap).map(u => ({
      ...u,
      mainLocationId: bsMainLoc[u.id] || "",
    })),
    company: { 
      ...newData.json?.viewConfig,
      locations: Object.entries(bsLocations).map(([id,name]) => ({id, name})),
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
