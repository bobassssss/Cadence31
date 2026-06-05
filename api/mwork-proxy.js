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

  // 1. Essayer getPlannerData (ancien format avec noms inclus)
  const urlOld = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData` +
    `?mode=${mode}&date=${date}&companyId=693042e16ec252fe0f990934&timezone=Europe%2FParis&granularity=60`;

  const oldResp = await fetch(urlOld, { headers });
  if (oldResp.status === 401 || oldResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });

  if (oldResp.ok) {
    // Ancien format — retourner tel quel
    const data = await oldResp.json();
    try {
      const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
      if (torResp.ok) data.timeOffRequestList = (await torResp.json()).timeOffRequestList || [];
    } catch(e) {}
    data.activityCatalog = buildCatalog(data);
    return res.status(200).json(data);
  }

  // 2. Fallback : user-planning (nouveau format — shifts plats par userId)
  const urlNew = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-planning` +
    `?mode=${mode}&date=${date}&timezone=Europe%2FParis&granularity=720&firstDayOfWeek=1`;

  const newResp = await fetch(urlNew, { headers });
  if (!newResp.ok)
    return res.status(newResp.status).json({ error: `Erreur m-work : ${newResp.status}` });

  const newData = await newResp.json();
  const shifts = newData.json?.users || newData.users || [];

  // 3. Récupérer les noms via user/schedule pour chaque userId unique
  const userIds = [...new Set(shifts.map(s => s.userId).filter(Boolean))];
  const userNames = {};

  await Promise.all(userIds.map(async (uid) => {
    try {
      const r = await fetch(
        `https://app.m-work.co/v2/api/user/schedule?startDate=${date}&userId=${uid}`,
        { headers }
      );
      if (r.ok) {
        const d = await r.json();
        const fn = d.schedule?.firstName || d.firstName || "";
        const ln = d.schedule?.lastName || d.lastName || "";
        if (fn || ln) userNames[uid] = { firstName: fn, lastName: ln };
      }
    } catch(e) {}
  }));

  // 4. Regrouper les shifts par userId et reconstruire le format attendu
  const usersMap = {};
  shifts.forEach(shift => {
    const uid = shift.userId;
    if (!uid) return;
    if (!usersMap[uid]) {
      const name = userNames[uid] || {};
      usersMap[uid] = {
        id: uid,
        _id: uid,
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

  // 5. Récupérer les activités (shifts de type activity)
  try {
    const actUrl = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/user-activities` +
      `?mode=${mode}&date=${date}&timezone=Europe%2FParis`;
    const actResp = await fetch(actUrl, { headers });
    if (actResp.ok) {
      const actData = await actResp.json();
      const acts = actData.json?.users || actData.users || [];
      acts.forEach(a => {
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

  // 6. time_off_request
  let timeOffRequests = [];
  try {
    const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`, { headers });
    if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList || [];
  } catch(e) {}

  // 7. Catalogue d'activités
  const activityCatalog = buildCatalog(newData);

  // Construire la réponse dans l'ancien format
  const result = {
    users: Object.values(usersMap),
    company: newData.json?.viewConfig || {},
    timeOffRequestList: timeOffRequests,
    activityCatalog,
  };

  return res.status(200).json(result);
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
