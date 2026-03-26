export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { cookie, date, mode = "month" } = req.body;
  if (!cookie || !date) return res.status(400).json({ error: "cookie et date requis" });

  const PLANNER = "69aea462646ef8fbf8ebd9ee";
  const COMPANY = "693042e16ec252fe0f990934";
  const url = `https://app.m-work.co/v2/api/planner/${PLANNER}/getPlannerData?mode=${mode}&date=${date}&companyId=${COMPANY}&timezone=Europe%2FParis&granularity=60`;

  const mw = await fetch(url, {
    headers: { Cookie: cookie, Accept: "*/*" }
  });

  if (mw.status === 401 || mw.status === 403)
    return res.status(401).json({ error: "Session m-work expirée — recopiez votre cookie" });
  if (!mw.ok)
    return res.status(mw.status).json({ error: `Erreur m-work : ${mw.status}` });

  const data = await mw.json();
  res.status(200).json(data);
}
