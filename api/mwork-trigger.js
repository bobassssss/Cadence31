// api/mwork-trigger.js — Import automatique m-work via MacroDroid
const { createClient } = require("@supabase/supabase-js");

const PLANNER_ID = "69aea462646ef8fbf8ebd9ee";
const COMPANY_ID = "693042e16ec252fe0f990934";

// Maps identiques au frontend
const MW_LOC_MAP = {
  "69bbb7c35493f0f79bbea06c":"F",
  "69bbb7c335d5cda3d7955698":"DP",
  "69bbb7c37a5c0285bc230597":"R",
  "693186ac23c0c0a98643b08a":"CRC",
  "693047383d2051bb1311017d":"CRC",
  "6930485568a91fe7e5cda5aa":"CRC",
  "6931879cd33cf9536abee1dc":"CRC",
  "693188920fd2a98023b4c991":"CRC",
};
const MW_OFFTYPE_MAP = {
  "6971f8464b4fb9488a457602":"CV",
  "69bbc128f6da1a436abc2e9b":"F",
  "69bbc1377a47336ded783622":"O",
  "69bbc1998d2c83a034dab0e2":"O",
};
const MW_ACT_MAP = {
  "69304523127fe6908b2827b4":"ACCUEIL",
  "69bbbef97a47336ded78361e":"ACCUEIL",
  "693044c2e4c31c90fc922c80":"GDV",
};

const MONTHS_FR = {
  janvier:1,fevrier:2,février:2,mars:3,avril:4,mai:5,juin:6,
  juillet:7,aout:8,août:8,septembre:9,octobre:10,novembre:11,decembre:12,décembre:12
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normName(s){ return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim(); }

function fmtDate(d){ return d.toISOString().slice(0,10); }

function mwSlot(startDateStr){ return new Date(startDateStr).getUTCHours() < 11 ? "AM" : "PM"; }

function parsePeriod(subject) {
  const s = normName(subject || "");
  const curYear = new Date().getFullYear();

  const yearMatch = s.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1]);
    return Array.from({length:12}, (_,i) => `${y}-${String(i+1).padStart(2,"0")}-01`);
  }
  const rangeMatch = s.match(/([a-z]+)-([a-z]+)/);
  if (rangeMatch) {
    const m1 = MONTHS_FR[rangeMatch[1]], m2 = MONTHS_FR[rangeMatch[2]];
    if (m1 && m2) {
      const dates = [];
      for (let m = m1; m <= m2; m++) dates.push(`${curYear}-${String(m).padStart(2,"0")}-01`);
      return dates;
    }
  }
  for (const [name, num] of Object.entries(MONTHS_FR))
    if (s.includes(name)) return [`${curYear}-${String(num).padStart(2,"0")}-01`];

  const now = new Date();
  return [`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`];
}

function suggestMember(members, mwFirst, mwLast) {
  const nFirst = normName(mwFirst), nLast = normName(mwLast);
  const full1 = nFirst+" "+nLast, full2 = nLast+" "+nFirst;
  let best = null, bestScore = 0;
  members.forEach(m => {
    const mn = normName(m.name); const parts = mn.split(" ");
    let score = 0;
    if (mn===full1||mn===full2) score=10;
    else if (nFirst.length>1&&nLast.length>1&&mn.includes(nFirst)&&mn.includes(nLast)) score=8;
    else if (nLast.length>2&&mn.includes(nLast)) score=5;
    else if (nFirst.length>2&&mn.includes(nFirst)) score=3;
    else {
      const mwParts=[nFirst,...nLast.split("-"),...nFirst.split("-")];
      const common=mwParts.filter(w=>w.length>2&&parts.some(p=>p===w||p.startsWith(w)||w.startsWith(p))).length;
      if(common>0) score=common;
    }
    if (score>bestScore){bestScore=score;best=m;}
  });
  return bestScore>=3 ? best : null;
}

function userToEntries(mwUser, ourMember, members) {
  const entries = {};
  const teams = [...new Set(members.map(m=>m.team))];
  const teamIdx = ourMember ? teams.indexOf(ourMember.team) : 0;
  const n = teamIdx >= 0 ? teamIdx+1 : 1;
  const ACCUEIL_CODE = `A${n}`, GDV_CODE = `G${n}`;
  const mid = ourMember.id;

  const addEntry = (date, slot, act, override=false) => {
    const key = `${mid}|${date}|${slot}`;
    if (!override && entries[key]) return;
    entries[key] = {act, comment:""};
  };

  const mainLocId = mwUser.mainLocationId || "";

  // 1. Shifts
  (mwUser.scheduledShifts||[]).forEach(s => {
    const date = s.planningDate, slot = s.dayPart;
    if (!date||!slot) return;
    let act, comment="";
    if (s.type==="office") {
      const locId = s.locationId||"";
      if (MW_LOC_MAP[locId]) act=MW_LOC_MAP[locId];
      else if (locId&&locId!==mainLocId) { act="."; comment=locId; }
      else act=".";
    } else if (s.type==="off") {
      act = s.offTypeId ? (MW_OFFTYPE_MAP[s.offTypeId]||"O") : "/";
    }
    if (act) { const key=`${mid}|${date}|${slot}`; if(!entries[key]) entries[key]={act,comment}; }
  });

  // 2. Activités Accueil/GDV
  (mwUser.activities||[]).forEach(a => {
    const type = MW_ACT_MAP[a.activityId];
    if (!type) return;
    const date = (a.startDate||"").slice(0,10);
    if (!date) return;
    const slot = mwSlot(a.startDate);
    addEntry(date, slot, type==="ACCUEIL"?ACCUEIL_CODE:GDV_CODE, true);
  });

  return entries;
}

function processTimeOff(r, mid) {
  if (r.status==="DENIED") return {};
  const act = r.status==="APPROVED" ? "CV" : "CP";
  const debut = r.startDate||"", fin = r.endDate||debut;
  if (!debut) return {};
  const entries = {};
  const d = new Date(debut+"T12:00:00"), f = new Date((fin||debut)+"T12:00:00");
  if (isNaN(d.getTime())) return {};
  while (d<=f) {
    if (d.getDay()!==0) {
      const dateStr = fmtDate(d);
      const isFirst=dateStr===debut, isLast=dateStr===fin;
      let slots=["AM","PM"];
      if (isFirst&&isLast) { slots = r.startHalf===r.endHalf?[r.startHalf||"AM"]:["AM","PM"]; }
      else if (isFirst) { slots = r.startHalf==="PM"?["PM"]:["AM","PM"]; }
      else if (isLast)  { slots = r.endHalf==="AM"?["AM"]:["AM","PM"]; }
      slots.forEach(slot => { entries[`${mid}|${dateStr}|${slot}`]={act,comment:""}; });
    }
    d.setDate(d.getDate()+1);
  }
  return entries;
}

// ── Handler principal ─────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","content-type, authorization");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST") return res.status(405).json({error:"Method not allowed"});

  const secret = (req.headers["authorization"]||"").replace("Bearer ","");
  if (!process.env.MWORK_TRIGGER_SECRET || secret!==process.env.MWORK_TRIGGER_SECRET)
    return res.status(401).json({error:"Non autorisé"});

  const { cookie, subject } = req.body;
  if (!cookie || cookie.trim().length < 20)
    return res.status(400).json({error:"Cookie manquant ou invalide"});

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const months = parsePeriod(subject);
  const headers = { Cookie: cookie.trim(), Accept:"*/*", "User-Agent":"Mozilla/5.0" };

  try {
    // 1. Charger les membres depuis Supabase
    const { data: members } = await sb.from("members").select("*").order("sort_order");
    if (!members||members.length===0) return res.status(500).json({error:"Aucun membre en base"});

    // 2. Récupérer les données m-work pour chaque mois
    let mergedUsers = null, baseData = null, activityCatalog = {};

    for (let i=0; i<months.length; i++) {
      const url = `https://app.m-work.co/v2/api/planner/${PLANNER_ID}/getPlannerData`
        + `?mode=month&date=${months[i]}&companyId=${COMPANY_ID}&timezone=Europe%2FParis&granularity=60`;
      const resp = await fetch(url, {headers});
      if (resp.status===401||resp.status===403)
        return res.status(401).json({error:"Cookie m-work expiré"});
      if (!resp.ok) return res.status(resp.status).json({error:`Erreur m-work ${resp.status}`});
      const data = await resp.json();

      // Catalogue d'activités
      const find = obj => {
        if (!obj||typeof obj!=="object") return;
        if (Array.isArray(obj)) { obj.forEach(find); return; }
        if (typeof obj.id==="string"&&obj.id.length===24&&obj.name&&obj.externalId)
          activityCatalog[obj.id]={name:obj.name,color:obj.color||"",code:obj.externalId};
        Object.values(obj).forEach(find);
      };
      find(data);

      if (!baseData) {
        baseData = data;
        mergedUsers = data.json.planner.users.map(u=>({...u,scheduledShifts:[...u.scheduledShifts],activities:[...u.activities]}));
      } else {
        data.json.planner.users.forEach(mu=>{
          const ex = mergedUsers.find(u=>u.id===mu.id);
          if (ex) { ex.scheduledShifts.push(...mu.scheduledShifts); ex.activities.push(...mu.activities); }
        });
      }
    }

    // 3. time_off_requests
    let timeOffRequests = [];
    try {
      const torResp = await fetch(`https://app.m-work.co/v2/api/time_off_request?scope=manager`,{headers});
      if (torResp.ok) timeOffRequests = (await torResp.json()).timeOffRequestList||[];
    } catch(e) {}

    // 4. Mapper m-work → membres app + construire les entrées
    const allEntries = {};
    const mwToOur = {};
    mergedUsers.forEach(u => {
      const ourMember = suggestMember(members, u.firstName, u.lastName);
      if (!ourMember) return;
      mwToOur[u.id] = ourMember.id;
      Object.assign(allEntries, userToEntries(u, ourMember, members));
    });

    // time_off_requests
    timeOffRequests.forEach(r => {
      const ourMemberId = mwToOur[r.userId];
      if (!ourMemberId) return;
      const e = processTimeOff(r, ourMemberId);
      Object.entries(e).forEach(([k,v]) => { if(!allEntries[k]) allEntries[k]=v; });
    });

    // 5. Upsert planning
    const rows = Object.entries(allEntries).map(([key,v])=>({key,act:v.act,comment:v.comment||"",count_as:null}));
    const CHUNK = 200;
    for (let i=0; i<rows.length; i+=CHUNK)
      await sb.from("planning").upsert(rows.slice(i,i+CHUNK),{onConflict:"key"});

    // 6. Planning detail (activités horaires)
    const detailRows = [];
    mergedUsers.forEach(u => {
      const ourMemberId = mwToOur[u.id];
      if (!ourMemberId) return;
      (u.activities||[]).forEach(a => {
        if (!a.startDate||!a.activityId) return;
        const date = a.startDate.slice(0,10);
        const cat = activityCatalog[a.activityId]||{};
        const toTime = s => new Date(s).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Paris"});
        detailRows.push({member_id:ourMemberId,date,start_time:toTime(a.startDate),end_time:toTime(a.endDate),
          activity_id:a.activityId,activity_name:cat.name||"",activity_code:cat.code||"",activity_color:cat.color||""});
      });
    });

    // Supprimer l'ancien détail et réinsérer
    const detailDates = [...new Set(detailRows.map(r=>r.date))].sort();
    const detailMembers = [...new Set(detailRows.map(r=>r.member_id))];
    if (detailDates.length>0) {
      for (const mid of detailMembers)
        await sb.from("planning_detail").delete().eq("member_id",mid).gte("date",detailDates[0]).lte("date",detailDates[detailDates.length-1]);
    }
    for (let i=0; i<detailRows.length; i+=CHUNK)
      await sb.from("planning_detail").insert(detailRows.slice(i,i+CHUNK));

    return res.status(200).json({
      success:true,
      message:`Import OK — ${months.length} mois, ${Object.keys(mwToOur).length} collaborateurs, ${rows.length} entrées`,
      months: months.length,
      entries: rows.length,
      detail: detailRows.length,
    });

  } catch(err) {
    return res.status(500).json({error:err.message});
  }
};
