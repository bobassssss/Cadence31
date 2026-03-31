// api/mwork-proxy.js
// Proxy Vercel → appelle m-work API (getPlannerData + time_off_request)

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

  // 1. getPlannerData (présences, activités, shifts)
  const plannerUrl =
    `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData` +
    `?mode=${mode}&date=${date}&companyId=${COMPANY_ID}&timezone=Europe%2FParis&granularity=60`;

  const plannerResp = await fetch(plannerUrl, { headers });
  if (plannerResp.status === 401 || plannerResp.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!plannerResp.ok)
    return res.status(plannerResp.status).json({ error: `Erreur m-work planner : ${plannerResp.status}` });

  const plannerData = await plannerResp.json();

  // 2. time_off_request (demandes de congés PENDING + APPROVED)
  // Appelé une seule fois (pas par mois) — contient toutes les demandes
  let timeOffRequests = [];
  try {
    const torResp = await fetch(
      `https://app.m-work.co/v2/api/time_off_request?scope=manager`,
      { headers }
    );
    if (torResp.ok) {
      const torData = await torResp.json();
      timeOffRequests = torData.timeOffRequestList || [];
    }
  } catch (e) {
    // Non bloquant — on continue sans les demandes
    console.error("time_off_request error:", e);
  }

  // Injecter les demandes dans la réponse
  plannerData.timeOffRequestList = timeOffRequests;

  return res.status(200).json(plannerData);
};
