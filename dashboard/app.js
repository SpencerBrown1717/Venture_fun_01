"use strict";

// ===========================================================================
// SCOUT — Pre-Form-D Venture Radar (static).
// Reads precomputed data.json (from the scout pipeline) and renders a
// filterable / sortable / searchable analyst workflow with a review queue,
// data-health panel, leaderboard, and per-company evidence drawer.
//
// Design intent: separate VERIFIED EVIDENCE from INFERENCE, everywhere.
// ===========================================================================

const state = {
  data: null,
  watch: null,
  vc: null,
  companies: [],
  byId: {},
  filtered: [],
  view: "grid",
  tab: "all",
  watchFilters: { stage: "", sort: "size", aiOnly: true },
  investorFilters: { sort: "deals", query: "", aiOnly: false },
  review: loadReview(),
  filters: {
    aiOnly: true, category: "", financing: "", tier: "", source: "",
    reviewFilter: "", minEv: 0, minOpp: 0, sort: "score", query: "",
    _minRaised: 0, _dateFloor: null,
  },
};

// --- Review workflow (localStorage, no backend) ----------------------------
const REVIEW = {
  needs_review:   { label: "Needs review",   short: "Review",   icon: "◎" },
  track_weekly:   { label: "Track weekly",   short: "Tracking", icon: "↻" },
  outreach_ready: { label: "Outreach ready", short: "Outreach", icon: "✦" },
  pass:           { label: "Pass",           short: "Pass",     icon: "—" },
};
const REVIEW_ORDER = ["needs_review", "track_weekly", "outreach_ready", "pass"];
const CYCLE = [null, "needs_review", "track_weekly", "outreach_ready", "pass"];

function loadReview() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem("scout:review") || "{}") || {}; } catch (_) {}
  // Migrate the old binary watchlist → "track weekly".
  if (!Object.keys(map).length) {
    try {
      const old = JSON.parse(localStorage.getItem("scout:watch") || "[]");
      old.forEach((id) => { map[id] = "track_weekly"; });
    } catch (_) {}
  }
  return map;
}
function saveReview() { localStorage.setItem("scout:review", JSON.stringify(state.review)); }
function reviewOf(id) { return state.review[id] || null; }
function setReview(id, status) {
  if (!status) delete state.review[id]; else state.review[id] = status;
  saveReview();
  refreshAfterReview(id);
}
function cycleReview(id) {
  const cur = reviewOf(id);
  const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
  setReview(id, next);
}
function refreshAfterReview(id) {
  updateReviewCount();
  document.querySelectorAll(`[data-rvchip="${CSS.escape(id)}"]`).forEach((el) => {
    const st = reviewOf(id);
    el.className = `rvchip ${st ? "rv-" + st : "rv-none"}`;
    el.textContent = st ? `${REVIEW[st].icon} ${REVIEW[st].short}` : "+ Triage";
  });
  document.querySelectorAll(`[data-rvbtn][data-id="${CSS.escape(id)}"]`).forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-rvbtn") === reviewOf(id));
  });
  if (state.tab === "review") renderReview();
}

// --- Backward-compatible accessors -----------------------------------------
const formDFound = (c) => c.form_d_found !== undefined ? c.form_d_found : !!(c.raw && c.raw.cik);
const tierOf = (c) => c.source_tier || (formDFound(c) ? 1 : (c.raw && c.raw.accelerator ? 2 : 5));
const financingOf = (c) => c.financing_stage || (formDFound(c) ? "Confirmed Form D" : "Unknown financing status");
const evidenceOf = (c) => (c.evidence_score !== undefined ? c.evidence_score : 50);
const oppOf = (c) => (c.scores && c.scores.overall) || 0;
const sourceTypesOf = (c) => (c.source_records || []).map((r) => r.source_type);
const TIER_LABEL = { 1: "SEC confirmed", 2: "Accelerator", 3: "Website + founder", 4: "Domain + job", 5: "Weak signal" };
const SRC_LABEL = {
  sec_form_d: "SEC Form D", state_incorporation: "State registry", accelerator: "Accelerator",
  website: "Company website", job_posting: "Hiring signal", founder_profile: "Founder identity",
  product_launch: "Product launch", domain_signal: "Domain signal",
};

const $ = (id) => document.getElementById(id);
const fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = (ym) => {
  if (!ym || ym === "unknown") return "Unknown date";
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[parseInt(m, 10) - 1] || "?"} ${y}`;
};

const VERDICT_CLASS = {
  "Strong interest": "v-strong", "Track closely": "v-track",
  "Monitor": "v-monitor", "Pass for now": "v-pass",
};

const raisedOf = (c) => { const r = c.raw || {}; return r.amount_sold || r.offering_amount || 0; };
const stageOf = (c) => (c.raw && c.raw.stage) || (c.memo && c.memo.estimated_stage) || "";
const fmtMoney = (n) => {
  if (!n) return "";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
};

// --- Boot ------------------------------------------------------------------
async function load() {
  startClock();
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    state.data = await res.json();
  } catch (e) {
    $("groups").innerHTML = `<div class="empty">Could not load data.json. Run <code>python -m scout run --source sample --research --export</code>.</div>`;
    return;
  }
  state.companies = state.data.companies || [];
  state.companies.forEach((c) => { state.byId[c.id] = c; });
  // "Startups to Watch" is an optional companion dataset.
  try {
    const pr = await fetch("watch.json", { cache: "no-store" });
    if (pr.ok) state.watch = await pr.json();
  } catch (_) { state.watch = null; }
  // VC deals export (investor-centric view) — also optional.
  try {
    const vc = await fetch("vc_deals.json", { cache: "no-store" });
    if (vc.ok) state.vc = await vc.json();
  } catch (_) { state.vc = null; }
  initControls();
  initTabs();
  initHealth();
  initWatch();
  initInvestors();
  renderHealth();
  renderTrends();
  renderBoard();
  updateRadarCount();
  updateFormdCount();
  updateReviewCount();
  updateWatchCount();
  updateInvestorCount();
  apply();
}

function startClock() {
  const tick = () => {
    $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  tick();
  setInterval(tick, 30000);
}

// --- Data Health (spec 5.12) ----------------------------------------------
function initHealth() {
  $("healthToggle").addEventListener("click", () => {
    const d = $("healthDetail");
    const open = d.hidden;
    d.hidden = !open;
    $("healthToggle").setAttribute("aria-expanded", String(open));
    $("healthToggle").textContent = open ? "details ▴" : "details ▾";
  });
}

function renderHealth() {
  const cs = state.companies;
  const s = state.data.stats || {};
  const ai = cs.filter((c) => c.is_ai);
  const preFormD = cs.filter((c) => !formDFound(c));
  const confirmed = cs.filter((c) => formDFound(c));
  const probableSafe = cs.filter((c) => c.probable_safe_stage);
  const verifiedSite = cs.filter((c) => c.website_verified).length;
  const withFounders = cs.filter((c) => (c.founders || []).length).length;
  const withSources = cs.filter((c) => (c.source_records || []).length).length;
  const avgEv = Math.round(cs.reduce((a, c) => a + evidenceOf(c), 0) / Math.max(1, cs.length));
  const avgOpp = Math.round(ai.reduce((a, c) => a + oppOf(c), 0) / Math.max(1, ai.length));
  const needsReview = Object.keys(state.review).length;

  const strip = [
    { num: cs.length, lbl: "Companies" },
    { num: ai.length, lbl: "AI-related", accent: true },
    { num: preFormD.length, lbl: "Pre-Form-D", accent: true },
    { num: confirmed.length, lbl: "Confirmed Form D" },
    { num: avgEv, lbl: "Avg evidence" },
    { num: avgOpp, lbl: "Avg opportunity" },
  ];
  $("healthStrip").innerHTML = strip.map((c) =>
    `<div class="hstat"><div class="hnum ${c.accent ? "accent" : ""}">${escapeHtml(c.num)}</div><div class="hlbl">${escapeHtml(c.lbl)}</div></div>`
  ).join("");

  const gen = state.data.generated_at ? new Date(state.data.generated_at) : null;
  $("healthGen").textContent = gen ? `generated ${gen.toISOString().replace("T", " ").slice(0, 16)} UTC` : "";

  const sources = (s.sources || []).join(", ") || "—";
  const detail = [
    ["Sources", escapeHtml(sources)],
    ["Months covered", String((state.data.months || []).length)],
    ["Probable SAFE-stage", String(probableSafe.length)],
    ["Verified websites", `${verifiedSite} / ${cs.length}`],
    ["Companies with founders", `${withFounders} / ${cs.length}`],
    ["Companies with source records", `${withSources} / ${cs.length}`],
    ["Merged duplicates", String(s.merged_duplicates ?? 0)],
    ["In your review queue", String(needsReview)],
  ];
  $("healthDetail").innerHTML = detail.map(([k, v]) =>
    `<div class="hd-row"><span class="hd-k">${k}</span><span class="hd-v">${v}</span></div>`).join("");
}

// --- Tabs ------------------------------------------------------------------
const TABS = ["all", "radar", "formd", "review", "board", "watch", "investors"];
function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => switchTab(t.getAttribute("data-tab")));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      switchTab(next.getAttribute("data-tab"));
    });
  });
}
function switchTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.getAttribute("data-tab") === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    if (on) t.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  });
  TABS.forEach((n) => { $("panel-" + n).hidden = n !== name; });
  if (name === "radar") renderRadar();
  if (name === "formd") renderFormd();
  if (name === "review") renderReview();
  if (name === "watch") renderWatch();
  if (name === "investors") renderInvestors();
}

function updateRadarCount() {
  const ids = new Set(state.data.radar || []);
  const n = ids.size || state.companies.filter((c) => c.is_ai && !formDFound(c) && evidenceOf(c) >= 25).length;
  $("radarCount").textContent = n;
}
function updateFormdCount() {
  $("formdCount").textContent = state.companies.filter((c) => formDFound(c)).length;
}
function updateReviewCount() { $("reviewCount").textContent = Object.keys(state.review).length; }

function renderRadar() {
  const ids = new Set(state.data.radar || []);
  let rows = ids.size
    ? state.companies.filter((c) => ids.has(c.id))
    : state.companies.filter((c) => c.is_ai && !formDFound(c) && evidenceOf(c) >= 25);
  rows.sort((a, b) => oppOf(b) - oppOf(a));
  $("radarEmpty").hidden = rows.length !== 0;
  $("radarGroups").className = "groups" + (state.view === "list" ? " list" : "");
  $("radarGroups").innerHTML = rows.length
    ? `<div class="month-group"><div class="month-head">Tracking ${rows.length} pre-Form-D ${rows.length === 1 ? "company" : "companies"}</div><div class="cards">${rows.map(cardHtml).join("")}</div></div>`
    : "";
  bindCards($("radarGroups"));
}

function renderFormd() {
  let rows = state.companies.filter((c) => formDFound(c));
  // AI-relevant filings surface first, then by opportunity / capital.
  rows.sort((a, b) => (b.is_ai - a.is_ai) || oppOf(b) - oppOf(a) || raisedOf(b) - raisedOf(a));
  $("formdEmpty").hidden = rows.length !== 0;
  $("formdGroups").className = "groups" + (state.view === "list" ? " list" : "");
  $("formdGroups").innerHTML = rows.length
    ? `<div class="month-group"><div class="month-head">${rows.length} SEC-verified Form D ${rows.length === 1 ? "company" : "companies"}</div><div class="cards">${rows.map(cardHtml).join("")}</div></div>`
    : "";
  bindCards($("formdGroups"));
}

// --- Review queue ----------------------------------------------------------
function renderReview() {
  const ids = Object.keys(state.review);
  $("reviewEmpty").hidden = ids.length !== 0;
  if (!ids.length) { $("reviewGroups").innerHTML = ""; return; }

  const html = REVIEW_ORDER.map((status) => {
    const rows = state.companies.filter((c) => reviewOf(c.id) === status);
    if (!rows.length) return "";
    rows.sort((a, b) => oppOf(b) - oppOf(a));
    return `
      <div class="rq-group">
        <div class="rq-head rv-${status}"><span class="rq-icon">${REVIEW[status].icon}</span>${REVIEW[status].label}
          <span class="count">${rows.length}</span></div>
        <div class="cards">${rows.map(cardHtml).join("")}</div>
      </div>`;
  }).join("");
  $("reviewGroups").innerHTML = html;
  bindCards($("reviewGroups"));
}

// --- Leaderboard -----------------------------------------------------------
function renderBoard() {
  const board = (state.data.leaderboard || []).slice(0, 25);
  const head = `<thead><tr><th>#</th><th>Company</th><th class="bcat">Category</th><th class="num">Opp</th><th class="num bconf">Conf</th><th class="bverd">Verdict</th></tr></thead>`;
  const body = board.map((r, i) => {
    const c = state.byId[r.id];
    return `<tr data-board="${escapeHtml(r.id)}">
      <td class="rank">${i + 1}</td>
      <td class="bname">${escapeHtml(r.name)}${c && c.verified_real ? ' <span class="vdot" title="SEC-verified">✓</span>' : ""}</td>
      <td class="bcat">${escapeHtml(r.ai_category || "—")}</td>
      <td class="num"><b>${r.overall}</b></td>
      <td class="num bconf">${fmtPct(r.confidence)}</td>
      <td class="bverd"><span class="verdict ${VERDICT_CLASS[r.verdict] || ""}">${escapeHtml(r.verdict || "")}</span></td>
    </tr>`;
  }).join("");
  $("board").innerHTML = head + `<tbody>${body}</tbody>`;
  $("board").querySelectorAll("[data-board]").forEach((tr) =>
    tr.addEventListener("click", () => openMemo(tr.getAttribute("data-board"))));
}

// --- Startups to Watch (VC deals) ------------------------------------------
function watchDeals() { return (state.watch && state.watch.deals) || []; }
function updateWatchCount() {
  const n = watchDeals().filter((d) => d.is_ai).length || watchDeals().length;
  $("watchCount").textContent = n;
}
function initWatch() {
  const deals = watchDeals();
  if (!deals.length) return;
  const stages = [...new Set(deals.map((d) => d.stage).filter(Boolean))].sort();
  $("watchStage").innerHTML = `<option value="">All stages</option>` +
    stages.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  $("watchStage").addEventListener("change", (e) => { state.watchFilters.stage = e.target.value; renderWatch(); });
  $("watchSort").addEventListener("change", (e) => { state.watchFilters.sort = e.target.value; renderWatch(); });
  $("watchAiOnly").addEventListener("change", (e) => { state.watchFilters.aiOnly = e.target.checked; renderWatch(); });
}
function renderWatch() {
  const f = state.watchFilters;
  let rows = watchDeals().slice();
  if (!rows.length) {
    $("watchEmpty").hidden = false;
    $("watchEmpty").textContent = "No deals dataset loaded.";
    $("watchStrip").innerHTML = "";
    $("watchGroups").innerHTML = "";
    return;
  }
  if (f.aiOnly) rows = rows.filter((d) => d.is_ai);
  if (f.stage) rows = rows.filter((d) => d.stage === f.stage);
  rows.sort((a, b) => {
    if (f.sort === "name") return a.company.localeCompare(b.company);
    if (f.sort === "date") return (b.deal_date || "").localeCompare(a.deal_date || "");
    return (b.deal_size_usd_mn || 0) - (a.deal_size_usd_mn || 0);
  });

  const s = (state.watch && state.watch.stats) || {};
  const total = rows.reduce((a, d) => a + (d.deal_size_usd_mn || 0), 0);
  const strip = [
    { num: rows.length, lbl: "Funded startups", accent: true },
    { num: `$${total >= 1000 ? (total / 1000).toFixed(1) + "B" : Math.round(total) + "M"}`, lbl: "Capital tracked" },
    { num: s.investors ?? "—", lbl: "Investors" },
    { num: state.watch.source || "VC export", lbl: "Source", small: true },
  ];
  $("watchStrip").innerHTML = strip.map((c) =>
    `<div class="hstat"><div class="hnum ${c.accent ? "accent" : ""}" ${c.small ? 'style="font-size:18px"' : ""}>${escapeHtml(c.num)}</div><div class="hlbl">${escapeHtml(c.lbl)}</div></div>`
  ).join("");

  $("watchEmpty").hidden = rows.length !== 0;
  $("watchGroups").innerHTML = rows.map(dealCardHtml).join("");
}

const fmtMn = (n) => {
  if (!n) return "undisclosed";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  return n >= 1 ? `$${n % 1 ? n.toFixed(1) : n}M` : `$${Math.round(n * 1000)}K`;
};

function dealCardHtml(d) {
  const verticals = (d.verticals || []).slice(0, 4).map((v) => `<span class="tag cat">${escapeHtml(v)}</span>`).join("");
  const subs = (d.sub_industries || []).slice(0, 2).map((v) => `<span class="tag">${escapeHtml(v)}</span>`).join("");
  const invs = (d.investors || []);
  const invChips = invs.slice(0, 6).map((i) => `<span class="inv">${escapeHtml(i.name)}</span>`).join("");
  const more = invs.length > 6 ? `<span class="inv more">+${invs.length - 6}</span>` : "";
  const leads = (d.lead_partners || []).length
    ? `<div class="founders-line"><span class="fk">Lead</span>${escapeHtml(d.lead_partners.join(", "))}</div>` : "";
  return `
    <div class="card deal">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(d.company)}</h3>
          <div class="sub">${escapeHtml(d.city || "—")} · ${escapeHtml(d.deal_date || "?")}</div>
        </div>
        <div class="opp-badge size"><div class="v">${fmtMn(d.deal_size_usd_mn)}</div><div class="l">round</div></div>
      </div>
      <div class="metaline">
        <span class="pill-meta fin-confirmed">${escapeHtml(d.stage || "Deal")}</span>
        <span class="pill-meta">${escapeHtml(d.deal_status || "")}</span>
        ${d.primary_industry ? `<span class="pill-meta">${escapeHtml(d.primary_industry)}</span>` : ""}
      </div>
      <div class="tags">${verticals}${subs}</div>
      ${leads}
      <div class="inv-block">
        <div class="fk">${invs.length} investor${invs.length === 1 ? "" : "s"}</div>
        <div class="inv-row">${invChips}${more}</div>
      </div>
    </div>`;
}

// --- Investors (VC_Deals.xlsx) ---------------------------------------------
function vcInvestors() { return (state.vc && state.vc.investors) || []; }
function updateInvestorCount() { $("investorCount").textContent = vcInvestors().length; }

function initInvestors() {
  if (!vcInvestors().length) return;
  $("investorSort").addEventListener("change", (e) => { state.investorFilters.sort = e.target.value; renderInvestors(); });
  $("investorAiOnly").addEventListener("change", (e) => { state.investorFilters.aiOnly = e.target.checked; renderInvestors(); });
  $("investorSearch").addEventListener("input", debounce((e) => { state.investorFilters.query = e.target.value.toLowerCase().trim(); renderInvestors(); }, 180));
}

function renderInvestors() {
  const f = state.investorFilters;
  let rows = vcInvestors().slice();
  if (!rows.length) {
    $("investorEmpty").hidden = false;
    $("investorEmpty").textContent = "No VC deals dataset loaded.";
    $("investorStrip").innerHTML = "";
    $("investorGroups").innerHTML = "";
    return;
  }
  if (f.aiOnly) rows = rows.filter((i) => (i.ai_deals || 0) > 0);
  if (f.query) {
    rows = rows.filter((i) =>
      i.name.toLowerCase().includes(f.query) ||
      (i.companies || []).some((c) => c.name.toLowerCase().includes(f.query)));
  }
  rows.sort((a, b) => {
    if (f.sort === "name") return a.name.localeCompare(b.name);
    if (f.sort === "capital") return (b.total_usd_mn || 0) - (a.total_usd_mn || 0);
    return (b.deals || 0) - (a.deals || 0) || (b.total_usd_mn || 0) - (a.total_usd_mn || 0);
  });

  const s = (state.vc && state.vc.stats) || {};
  const strip = [
    { num: vcInvestors().length, lbl: "Investors", accent: true },
    { num: s.firms ?? "—", lbl: "Portfolio firms" },
    { num: s.profiles_verified ?? "—", lbl: "Verified profiles" },
    { num: state.vc.source || "VC export", lbl: "Source", small: true },
  ];
  $("investorStrip").innerHTML = strip.map((c) =>
    `<div class="hstat"><div class="hnum ${c.accent ? "accent" : ""}" ${c.small ? 'style="font-size:18px"' : ""}>${escapeHtml(c.num)}</div><div class="hlbl">${escapeHtml(c.lbl)}</div></div>`
  ).join("");

  $("investorEmpty").hidden = rows.length !== 0;
  $("investorGroups").innerHTML = rows.map(investorCardHtml).join("");
  $("investorGroups").querySelectorAll("[data-investor]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      openInvestor(el.getAttribute("data-investor"));
    })
  );
}

function investorLinkBar(p, compact) {
  if (!p) return "";
  const links = [];
  const v = p.verified;
  if (p.website) links.push(`<a class="inv-link web${v ? "" : " guess"}" href="${escapeHtml(p.website)}" target="_blank" rel="noopener" title="Website">${compact ? "↗" : "Website"}</a>`);
  if (p.linkedin) links.push(`<a class="inv-link li${v ? "" : " search"}" href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener" title="LinkedIn">LinkedIn</a>`);
  if (p.x) links.push(`<a class="inv-link x${v ? "" : " search"}" href="${escapeHtml(p.x)}" target="_blank" rel="noopener" title="X">X</a>`);
  if (p.email) links.push(`<a class="inv-link mail${v ? "" : " guess"}" href="mailto:${escapeHtml(p.email)}" title="Email">${compact ? "✉" : p.email}</a>`);
  if (!links.length) return "";
  return `<div class="inv-links">${links.join("")}</div>`;
}

function investorCardHtml(inv) {
  const loc = [inv.city, inv.state, inv.country].filter(Boolean).join(", ");
  const p = inv.profile || {};
  const firms = (inv.companies || []);
  const firmChips = firms.slice(0, 6).map((c) =>
    `<span class="inv${c.is_ai ? " ai" : ""}" title="${escapeHtml((c.stage || "") + (c.size_usd_mn ? " · " + fmtMn(c.size_usd_mn) : ""))}">${escapeHtml(c.name)}</span>`
  ).join("");
  const more = firms.length > 6 ? `<span class="inv more">+${firms.length - 6}</span>` : "";
  const stages = (inv.stages || []).map((s) => `<span class="pill-meta">${escapeHtml(s.stage)} ×${s.count}</span>`).join("");
  const focus = (inv.focus || []).slice(0, 4).map((v) => `<span class="tag cat">${escapeHtml(v)}</span>`).join("");
  const partners = inv.lead_partners || [];
  const partnerNames = partners.slice(0, 3).map((p) => escapeHtml(p.name)).join(", ");
  const partnerLine = partners.length
    ? `<div class="founders-line"><span class="fk">Partners</span>${partnerNames}${partners.length > 3 ? ` +${partners.length - 3}` : ""}</div>`
    : "";
  const tagline = p.tagline ? `<div class="inv-tagline">${escapeHtml(p.tagline)}</div>` : "";
  const verified = p.verified ? `<span class="vbadge">✓ Verified profile</span>` : "";
  return `
    <div class="card deal investor" data-investor="${escapeHtml(inv.name)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(inv.name)} profile">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(inv.name)} ${verified}</h3>
          <div class="sub">${escapeHtml(loc || "—")}${inv.latest_deal ? ` · latest ${escapeHtml(inv.latest_deal)}` : ""}</div>
          ${tagline}
        </div>
        <div class="opp-badge size"><div class="v">${inv.deals}</div><div class="l">${inv.deals === 1 ? "deal" : "deals"}</div></div>
      </div>
      ${investorLinkBar(p, true)}
      <div class="metaline">
        ${inv.type ? `<span class="pill-meta">${escapeHtml(inv.type)}</span>` : ""}
        ${inv.total_usd_mn ? `<span class="pill-meta raised">${fmtMn(inv.total_usd_mn)} alongside</span>` : ""}
        ${inv.ai_deals ? `<span class="pill-meta fin-safe">${inv.ai_deals} AI</span>` : ""}
        ${stages}
      </div>
      ${focus ? `<div class="tags">${focus}</div>` : ""}
      ${partnerLine}
      <div class="inv-block">
        <div class="fk">Portfolio in this dataset</div>
        <div class="inv-row">${firmChips}${more}</div>
      </div>
      <div class="card-foot">
        <span class="sub">Click for full profile</span>
        <button class="memo-btn" type="button">Profile →</button>
      </div>
    </div>`;
}

function openInvestor(name) {
  const inv = vcInvestors().find((i) => i.name === name);
  if (!inv) return;
  const p = inv.profile || {};
  const loc = [inv.city, inv.state, inv.country].filter(Boolean).join(", ");
  const portfolio = (inv.companies || []).map((c) =>
    `<tr><td class="bname">${escapeHtml(c.name)}</td><td>${escapeHtml(c.stage || "—")}</td><td class="num">${c.size_usd_mn ? fmtMn(c.size_usd_mn) : "—"}</td><td>${escapeHtml(c.date || "—")}</td><td>${c.is_ai ? '<span class="pill-meta fin-safe">AI</span>' : ""}</td></tr>`
  ).join("");
  const stages = (inv.stages || []).map((s) => `<span class="pill-meta">${escapeHtml(s.stage)} ×${s.count}</span>`).join(" ");
  const focus = (inv.focus || []).map((v) => `<span class="tag cat">${escapeHtml(v)}</span>`).join("");
  const partnerRows = (inv.lead_partners || []).map((pr) => `
    <div class="partner-row">
      <span class="partner-name">${escapeHtml(pr.name)}</span>
      <span class="partner-links">
        ${pr.linkedin ? `<a class="inv-link li search" href="${escapeHtml(pr.linkedin)}" target="_blank" rel="noopener" title="Find on LinkedIn">in</a>` : ""}
        ${pr.x ? `<a class="inv-link x search" href="${escapeHtml(pr.x)}" target="_blank" rel="noopener" title="Find on X">X</a>` : ""}
        ${pr.email ? `<a class="inv-link mail${pr.email_guess ? " guess" : ""}" href="mailto:${escapeHtml(pr.email)}" title="${pr.email_guess ? "Best-guess email" : "Email"}">✉ ${escapeHtml(pr.email)}</a>` : ""}
      </span>
    </div>`).join("");
  const linksFull = investorLinkBar(p, false);
  const cta = linksFull ? `<div class="drawer-cta inv-cta">${linksFull.replace(/class="inv-links"/g, 'class="inv-links full"')}</div>` : "";

  $("drawer").innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <h2>${escapeHtml(inv.name)}</h2>
    <div class="memo-sub">${escapeHtml(loc)}${p.tagline ? ` · ${escapeHtml(p.tagline)}` : ""}
      <span class="badge-gen">${p.verified ? "verified profile" : "search links"}</span></div>
    ${cta}
    <div class="memo-grid">
      <div class="memo-kv"><div class="k">Deals in dataset</div><div class="v">${inv.deals}</div></div>
      <div class="memo-kv"><div class="k">Capital alongside</div><div class="v">${inv.total_usd_mn ? fmtMn(inv.total_usd_mn) : "—"}</div></div>
      <div class="memo-kv"><div class="k">AI portfolio</div><div class="v">${inv.ai_deals || 0} firms</div></div>
      <div class="memo-kv"><div class="k">Latest deal</div><div class="v">${escapeHtml(inv.latest_deal || "—")}</div></div>
      <div class="memo-kv"><div class="k">Firm type</div><div class="v">${escapeHtml(inv.type || "—")}</div></div>
      <div class="memo-kv"><div class="k">HQ</div><div class="v">${escapeHtml(loc || "—")}</div></div>
    </div>
    ${stages ? `<div class="memo-sec"><h4>Stage mix</h4><div class="metaline">${stages}</div></div>` : ""}
    ${focus ? `<div class="memo-sec"><h4>Focus areas</h4><div class="tags">${focus}</div></div>` : ""}
    ${partnerRows ? `<div class="memo-sec"><h4>Lead partners (from deals)</h4><div class="partner-list">${partnerRows}</div><div class="partner-note">LinkedIn / X are people-search links; emails marked ◌ are best-guess from the firm domain.</div></div>` : ""}
    <div class="memo-sec">
      <h4>Portfolio firms (${inv.deals})</h4>
      <div class="board-wrap inv-portfolio">
        <table class="board"><thead><tr><th>Company</th><th>Stage</th><th class="num">Round</th><th>Date</th><th></th></tr></thead><tbody>${portfolio}</tbody></table>
      </div>
    </div>
    <div class="drawer-cta">
      ${p.website ? `<a class="primary" href="${escapeHtml(p.website)}" target="_blank" rel="noopener">Visit website ↗</a>` : ""}
      ${p.linkedin ? `<a href="${escapeHtml(p.linkedin)}" target="_blank" rel="noopener">LinkedIn ↗</a>` : ""}
      ${p.x ? `<a href="${escapeHtml(p.x)}" target="_blank" rel="noopener">X ↗</a>` : ""}
      ${p.email ? `<a href="mailto:${escapeHtml(p.email)}">Email ↗</a>` : ""}
    </div>`;
  $("drawer").hidden = false;
  $("drawerOverlay").hidden = false;
  $("drawer").scrollTop = 0;
  $("drawer").querySelector(".close").addEventListener("click", closeMemo);
}

// --- Trends ----------------------------------------------------------------
function renderTrends() {
  const t = state.data.trends || {};
  const months = t.ai_by_month || [];
  const max = Math.max(1, ...months.map((m) => m.count));
  $("monthBars").innerHTML = months.map((m) => {
    const h = Math.round((m.count / max) * 100);
    return `<div class="bar-col"><div class="bar" style="height:${h}%" data-count="${m.count}"></div><div class="bar-label">${monthLabel(m.month).split(" ")[0]}</div></div>`;
  }).join("") || '<div class="mom-empty">No data</div>';

  const cats = t.categories || [];
  const catMax = Math.max(1, ...cats.map((c) => c.count));
  $("catList").innerHTML = cats.slice(0, 6).map((c) =>
    `<div class="catrow"><span class="nm">${escapeHtml(c.category)}</span><span class="ct">${c.count}</span><div class="track"><div class="fill" style="width:${(c.count / catMax) * 100}%"></div></div></div>`
  ).join("") || '<div class="mom-empty">No data</div>';

  const up = (t.accelerating || []).map((r) => `<div class="mom-row"><span class="pill up">▲ +${r.delta}</span><span>${escapeHtml(r.category)}</span></div>`);
  const down = (t.cooling || []).map((r) => `<div class="mom-row"><span class="pill down">▼ ${r.delta}</span><span>${escapeHtml(r.category)}</span></div>`);
  const mom = [...up, ...down];
  $("momentum").innerHTML = mom.length ? mom.join("") : '<div class="mom-empty">Need ≥2 months of data to compute momentum.</div>';

  const geo = t.geography || [];
  const geoMax = Math.max(1, ...geo.map((g) => g.count));
  $("geoList").innerHTML = geo.slice(0, 6).map((g) =>
    `<div class="catrow"><span class="nm">${escapeHtml(g.jurisdiction)}</span><span class="ct">${g.count}</span><div class="track"><div class="fill" style="width:${(g.count / geoMax) * 100}%"></div></div></div>`
  ).join("") || '<div class="mom-empty">No data</div>';
}

// --- Controls --------------------------------------------------------------
function initControls() {
  const cats = [...new Set(state.companies.filter((c) => c.ai_category).map((c) => c.ai_category))].sort();
  $("category").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const srcTypes = [...new Set(state.companies.flatMap(sourceTypesOf))].sort();
  $("source").innerHTML = `<option value="">All source types</option>` +
    srcTypes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(SRC_LABEL[s] || s)}</option>`).join("");

  $("aiOnly").addEventListener("change", (e) => { state.filters.aiOnly = e.target.checked; apply(); });
  $("category").addEventListener("change", (e) => { state.filters.category = e.target.value; apply(); });
  $("financing").addEventListener("change", (e) => { state.filters.financing = e.target.value; apply(); });
  $("tier").addEventListener("change", (e) => { state.filters.tier = e.target.value; apply(); });
  $("source").addEventListener("change", (e) => { state.filters.source = e.target.value; apply(); });
  $("reviewFilter").addEventListener("change", (e) => { state.filters.reviewFilter = e.target.value; apply(); });
  $("sort").addEventListener("change", (e) => { state.filters.sort = e.target.value; apply(); });
  $("minEv").addEventListener("input", (e) => {
    state.filters.minEv = +e.target.value; $("minEvLabel").textContent = e.target.value; apply();
  });
  $("minOpp").addEventListener("input", (e) => {
    state.filters.minOpp = +e.target.value; $("minOppLabel").textContent = e.target.value; apply();
  });
  $("search").addEventListener("input", debounce((e) => runQuery(e.target.value), 200));
  $("viewGrid").addEventListener("click", () => setView("grid"));
  $("viewList").addEventListener("click", () => setView("list"));

  const examples = ["robotics seed stage", "raised over $5M", "AI security", "formed this month", "high confidence"];
  $("examples").innerHTML = examples.map((q) => `<span class="chip">${escapeHtml(q)}</span>`).join("");
  document.querySelectorAll(".chip").forEach((ch) =>
    ch.addEventListener("click", () => { $("search").value = ch.textContent; runQuery(ch.textContent); })
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("search")) { e.preventDefault(); $("search").focus(); }
    if (e.key === "Escape") closeMemo();
  });
}

function setView(v) {
  state.view = v;
  $("viewGrid").classList.toggle("active", v === "grid");
  $("viewList").classList.toggle("active", v === "list");
  render();
  if (state.tab === "radar") renderRadar();
  if (state.tab === "formd") renderFormd();
}

// --- Natural-language query ------------------------------------------------
function runQuery(text) {
  const q = (text || "").toLowerCase().trim();
  state.filters.query = q;

  const catMap = {
    "infrastructure": "AI Infrastructure", "infra": "AI Infrastructure",
    "developer tool": "Developer Tools", "dev tool": "Developer Tools",
    "agent": "AI Agents", "agentic": "AI Agents", "vision": "Computer Vision",
    "nlp": "NLP / Language", "language": "NLP / Language",
    "robot": "Robotics", "health": "Healthcare AI", "clinical": "Healthcare AI",
    "fintech": "Fintech AI", "finance": "Fintech AI", "security": "AI Security",
    "generative": "Generative Media", "analytics": "Data / Analytics",
  };
  let matchedCat = "";
  for (const [k, v] of Object.entries(catMap)) { if (q.includes(k)) { matchedCat = v; break; } }
  if (matchedCat && [...$("category").options].some((o) => o.value === matchedCat)) {
    $("category").value = matchedCat; state.filters.category = matchedCat;
  }

  const cap = q.match(/(?:over|above|>\s*)\$?\s*(\d+(?:\.\d+)?)\s*(k|m|b)?/);
  state.filters._minRaised = 0;
  if (cap && (q.includes("rais") || q.includes("$") || q.includes("over") || q.includes("above"))) {
    let v = parseFloat(cap[1]);
    const unit = cap[2];
    v *= unit === "b" ? 1e9 : unit === "k" ? 1e3 : 1e6;
    state.filters._minRaised = v;
  }

  state.filters._dateFloor = null;
  const months = state.data.months || [];
  if (q.includes("this month") && months[0]) {
    state.filters._dateFloor = `${months[0]}-01`;
  } else {
    const days = q.match(/last\s+(\d+)\s+days?/);
    if (q.includes("last 30 days") || days) {
      const n = days ? parseInt(days[1], 10) : 30;
      const d = new Date(); d.setDate(d.getDate() - n);
      state.filters._dateFloor = d.toISOString().slice(0, 10);
    }
  }

  if (q.includes("high confidence") || q.includes("strong")) {
    $("minOpp").value = 70; $("minOppLabel").textContent = "70"; state.filters.minOpp = 70;
  }
  apply();
}

// --- Filter / sort ---------------------------------------------------------
function apply() {
  const f = state.filters;
  let rows = state.companies.slice();

  if (f.aiOnly) rows = rows.filter((c) => c.is_ai);
  if (f.category) rows = rows.filter((c) => c.ai_category === f.category);
  if (f.financing === "__none__") rows = rows.filter((c) => !formDFound(c));
  else if (f.financing) rows = rows.filter((c) => financingOf(c) === f.financing);
  if (f.tier) rows = rows.filter((c) => String(tierOf(c)) === f.tier);
  if (f.source) rows = rows.filter((c) => sourceTypesOf(c).includes(f.source));
  if (f.reviewFilter === "__untriaged__") rows = rows.filter((c) => !reviewOf(c.id));
  else if (f.reviewFilter) rows = rows.filter((c) => reviewOf(c.id) === f.reviewFilter);
  if (f.minEv > 0) rows = rows.filter((c) => evidenceOf(c) >= f.minEv);
  if (f.minOpp > 0) rows = rows.filter((c) => oppOf(c) >= f.minOpp);
  if (f._minRaised) rows = rows.filter((c) => raisedOf(c) >= f._minRaised);
  if (f._dateFloor) rows = rows.filter((c) => (c.formation_date || "") >= f._dateFloor);

  if (f.query) {
    const stop = ["this","month","last","days","companies","company","founded","formed","show","the","with","high","confidence","and","for","over","above","raised","stage","me"];
    const terms = f.query.split(/\s+/).filter((t) => t.length > 2 && !stop.includes(t) && !/^\$?\d/.test(t));
    if (terms.length) {
      rows = rows.filter((c) => {
        const hay = `${c.name} ${c.description} ${c.ai_category} ${stageOf(c)} ${(c.founders||[]).map(x=>x.name).join(" ")} ${(c.ai_signals || []).join(" ")}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
  }

  rows.sort((a, b) => {
    if (f.sort === "name") return a.name.localeCompare(b.name);
    if (f.sort === "date") return (b.formation_date || "").localeCompare(a.formation_date || "");
    if (f.sort === "raised") return raisedOf(b) - raisedOf(a);
    if (f.sort === "evidence") return evidenceOf(b) - evidenceOf(a);
    if (f.sort === "conf") return (b.ai_score || 0) - (a.ai_score || 0);
    return oppOf(b) - oppOf(a) || (b.ai_score || 0) - (a.ai_score || 0);
  });

  state.filtered = rows;
  render();
}

function render() {
  const rows = state.filtered;
  $("resultMeta").textContent = `${rows.length} ${rows.length === 1 ? "company" : "companies"} · click any card for the full memo · set a review status to triage`;
  $("empty").hidden = rows.length !== 0;

  const groups = {}; const order = [];
  for (const c of rows) {
    const m = c.month || "unknown";
    if (!groups[m]) { groups[m] = []; order.push(m); }
    groups[m].push(c);
  }
  order.sort((a, b) => (b === "unknown" ? -1 : a === "unknown" ? 1 : b.localeCompare(a)));

  $("groups").className = "groups" + (state.view === "list" ? " list" : "");
  $("groups").innerHTML = order.map((m) => `
    <div class="month-group">
      <div class="month-head">${monthLabel(m)} <span class="count">${groups[m].length} ${groups[m].length === 1 ? "company" : "companies"}</span></div>
      <div class="cards">${groups[m].map(cardHtml).join("")}</div>
    </div>`).join("");

  bindCards($("groups"));
}

function bindCards(root) {
  root.querySelectorAll("[data-memo]").forEach((b) =>
    b.addEventListener("click", (e) => {
      if (e.target.closest(".rvchip") || e.target.closest("a")) return;
      openMemo(b.getAttribute("data-memo"));
    })
  );
  root.querySelectorAll(".rvchip").forEach((s) =>
    s.addEventListener("click", (e) => { e.stopPropagation(); cycleReview(s.getAttribute("data-rvchip")); })
  );
}

// --- Card ------------------------------------------------------------------
function verifiedBadge(c) {
  if (!c.verified_real) return "";
  const prov = (c.verification || []).join(" · ");
  const edgarUrl = (c.raw && c.raw.edgar_url) || "";
  const title = `Verified real — ${prov || "authoritative registry"}`;
  return edgarUrl
    ? `<a class="vbadge" href="${escapeHtml(edgarUrl)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">✓ Verified</a>`
    : `<span class="vbadge" title="${escapeHtml(title)}">✓ Verified</span>`;
}

function linkFor(c) {
  const edgarUrl = (c.raw && (c.raw.filing_url || c.raw.edgar_url)) || "";
  const ycUrl = (c.raw && c.raw.accelerator_url) || "";
  if (c.website && c.website_verified) {
    return { url: c.website, label: c.website.replace(/^https?:\/\//, "").replace(/\/$/, "") };
  }
  if (edgarUrl) return { url: edgarUrl, label: "SEC filing ↗" };
  if (ycUrl) return { url: ycUrl, label: "YC profile ↗" };
  if (c.website) return { url: c.website, label: c.domain || "website ↗" };
  return { url: "", label: "" };
}

const FINANCE_CLASS = {
  "Confirmed Form D": "fin-confirmed", "Probable SAFE-stage": "fin-safe",
  "Probable SAFE-stage or bootstrapped": "fin-safe", "Pre-Form-D / early signal": "fin-early",
  "Weak unverified signal": "fin-weak", "Unknown financing status": "fin-weak",
};
const FIN_DUP_BADGES = new Set(["Confirmed Form D", "No Form D found", "Probable SAFE-stage"]);

function badgesHtml(c, max = 4, skipFinDup = false) {
  let b = c.badges || [];
  if (skipFinDup) b = b.filter((x) => !FIN_DUP_BADGES.has(x));
  if (!b.length) return "";
  return `<div class="badges">${b.slice(0, max).map((x) =>
    `<span class="badge b-${slug(x)}">${escapeHtml(x)}</span>`).join("")}</div>`;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function rvChipHtml(c) {
  const st = reviewOf(c.id);
  const cls = st ? "rv-" + st : "rv-none";
  const txt = st ? `${REVIEW[st].icon} ${REVIEW[st].short}` : "+ Triage";
  return `<button class="rvchip ${cls}" data-rvchip="${escapeHtml(c.id)}" title="Click to cycle review status">${txt}</button>`;
}

function cardHtml(c) {
  const { url: link, label: linkLabel } = linkFor(c);
  const cat = c.ai_category ? `<span class="tag cat">${escapeHtml(c.ai_category)}</span>` : "";
  const rec = c.recommendation;
  const recBadge = rec ? `<span class="verdict ${VERDICT_CLASS[rec.verdict] || ""}">${escapeHtml(rec.verdict)}</span>` : "";
  const opp = c.scores ? `<div class="opp-badge"><div class="v">${c.scores.overall}</div><div class="l">opp</div></div>` : "";
  const stage = stageOf(c);
  const raised = raisedOf(c);
  const fin = financingOf(c);
  const meta = [
    `<span class="pill-meta ${FINANCE_CLASS[fin] || ""}">${escapeHtml(fin)}</span>`,
    stage ? `<span class="pill-meta">${escapeHtml(stage)}</span>` : "",
    raised ? `<span class="pill-meta raised">${fmtMoney(raised)} raised</span>` : "",
    `<span class="pill-meta" title="Evidence score — how much we know (separate from opportunity)">ev ${evidenceOf(c)}</span>`,
  ].join("");
  const realFounders = (c.founders || []).filter((f) => f.source === "sec_filing");
  const fline = realFounders.length
    ? `<div class="founders-line"><span class="fk">Team</span>${escapeHtml(realFounders.slice(0, 3).map((f) => f.name).join(", "))}${realFounders.length > 3 ? ` +${realFounders.length - 3}` : ""}</div>`
    : "";

  return `
    <div class="card" data-memo="${escapeHtml(c.id)}">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(c.name)} ${verifiedBadge(c)}</h3>
          <div class="sub">${escapeHtml(c.jurisdiction || "—")} · formed ${escapeHtml(c.formation_date || "?")}</div>
        </div>
        ${opp}
      </div>
      <div class="metaline">${meta}</div>
      ${c.description ? `<p class="desc">${escapeHtml(c.description)}</p>` : ""}
      ${fline}
      ${badgesHtml(c, 4, true)}
      <div class="tags">${cat}${recBadge}</div>
      <div class="card-foot">
        ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(linkLabel)}</a>` : `<span class="sub">no website yet</span>`}
        <div class="foot-actions">
          ${rvChipHtml(c)}
          <button class="memo-btn">Analysis →</button>
        </div>
      </div>
    </div>`;
}

// --- Drawer ----------------------------------------------------------------
const DIM_LABELS = {
  team_quality: "Team", market_size: "Market size", product_differentiation: "Differentiation",
  technical_complexity: "Technical", defensibility: "Defensibility", timing: "Timing",
};

function scoreBarsHtml(scores) {
  if (!scores || !scores.dimensions) return "";
  const rows = Object.entries(scores.dimensions).map(([k, v]) => `
    <div class="dim">
      <div class="dim-top"><span>${escapeHtml(DIM_LABELS[k] || k)}</span><b>${v.score}</b></div>
      <div class="dim-track"><div class="dim-fill" style="width:${v.score}%"></div></div>
      <div class="dim-reason">${escapeHtml(v.reason || "")}</div>
    </div>`).join("");
  return `<div class="memo-sec"><h4>Opportunity score — ${scores.overall}/100 <span class="badge-gen">confidence ${fmtPct(scores.confidence)}</span></h4><div class="dims">${rows}</div></div>`;
}

function foundersHtml(founders) {
  if (!founders || !founders.length) return "";
  const real = founders.filter((f) => f.source === "sec_filing");
  const list = real.length ? real : founders;
  const items = list.map((f) => {
    const link = f.linkedin || f.profile_url;
    const prev = (f.previous_companies || []).map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join("");
    return `
    <div class="founder">
      <div class="founder-top"><b>${escapeHtml(f.name)}</b><span class="founder-role">${escapeHtml(f.role || "")}</span></div>
      ${f.background ? `<div class="founder-bg">${escapeHtml(f.background)}</div>` : ""}
      <div class="founder-meta">
        ${f.location ? `<span class="founder-loc">${escapeHtml(f.location)}</span>` : ""}
        ${prev}
        ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">in · find on LinkedIn ↗</a>` : ""}
      </div>
    </div>`;
  }).join("");
  const label = real.length ? "named in SEC filing" : (list[0]?.source || "");
  return `<div class="memo-sec"><h4>Founding team <span class="badge-gen">${escapeHtml(label)}</span></h4>${items}</div>`;
}

function competitiveHtml(comp) {
  if (!comp) return "";
  const leaders = (comp.leaders || []).map((l) => `<span class="tag cat">${escapeHtml(l)}</span>`).join("");
  const adj = (comp.adjacent || []).map((a) => `<span class="tag">${escapeHtml(a)}</span>`).join("");
  return `
    <div class="memo-sec">
      <h4>Competitive landscape</h4>
      ${comp.positioning ? `<p>${escapeHtml(comp.positioning)}</p>` : ""}
      <div class="comp-block"><div class="k">Category leaders</div><div class="tags">${leaders || "—"}</div></div>
      <div class="comp-block"><div class="k">Discovered peers</div><div class="tags">${adj || "<span class='founder-loc'>none yet in dataset</span>"}</div></div>
    </div>`;
}

function verificationHtml(c) {
  const prov = c.verification || [];
  const edgarUrl = (c.raw && c.raw.edgar_url) || "";
  const filingUrl = (c.raw && c.raw.filing_url) || edgarUrl;
  if (!prov.length && !filingUrl) return "";
  const items = prov.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const status = c.verified_real ? `<span class="vbadge">✓ Verified real</span>` : `<span class="badge-gen">unverified</span>`;
  return `<div class="memo-sec"><h4>Verification ${status}</h4>${items ? `<ul>${items}</ul>` : "<p>No authoritative signal found.</p>"}</div>`;
}

function evidencePanelHtml(c) {
  const recs = c.source_records || [];
  const tier = tierOf(c);
  const conf = c.evidence_confidence || "";
  const rows = recs.map((r) => {
    const u = r.source_url;
    const nm = escapeHtml(r.source_name || SRC_LABEL[r.source_type] || r.source_type);
    const link = u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${nm} ↗</a>` : nm;
    return `<li><span class="ev-type">${escapeHtml(SRC_LABEL[r.source_type] || r.source_type)}</span> ${link}${r.notes ? ` <span class="muted">· ${escapeHtml(r.notes)}</span>` : ""}</li>`;
  }).join("");
  const missing = (c.missing_data || []).map((m) => `<li class="miss">${escapeHtml(m)}</li>`).join("");
  return `
    <div class="memo-sec evidence">
      <h4>Why this company is here
        <span class="badge-gen" title="How much independent public evidence supports this record (separate from opportunity).">evidence ${evidenceOf(c)}/100 · ${escapeHtml(conf)}</span>
      </h4>
      <div class="ev-meta">
        <span class="pill-meta tier-${tier}">Tier ${tier} · ${escapeHtml(TIER_LABEL[tier] || "")}</span>
        <span class="pill-meta ${FINANCE_CLASS[financingOf(c)] || ""}">${escapeHtml(financingOf(c))}</span>
      </div>
      ${rows ? `<div class="ev-block"><div class="k">Sources used (verified)</div><ul class="ev-list">${rows}</ul></div>` : ""}
      ${missing ? `<div class="ev-block"><div class="k">Missing / not yet checked</div><ul class="ev-list">${missing}</ul></div>` : ""}
    </div>`;
}

function recommendedAction(c) {
  const miss = c.missing_data || [];
  const verdict = (c.recommendation && c.recommendation.verdict) || "";
  let line;
  if (!formDFound(c)) {
    const checks = miss.length ? miss.slice(0, 2).map((m) => m.toLowerCase()).join(" and ") : "founder identity";
    line = `Verify ${checks}, then watch for a Form D filing. Re-score weekly.`;
  } else {
    line = verdict === "Strong interest"
      ? "Financing confirmed — strong signal. Consider direct outreach."
      : "Form D confirmed. Track for follow-on signals and team build-out.";
  }
  return `<div class="memo-sec"><h4>Recommended next action</h4><p class="next-action">${escapeHtml(line)}</p></div>`;
}

function reviewActionsHtml(c) {
  const cur = reviewOf(c.id);
  const btns = REVIEW_ORDER.map((s) =>
    `<button class="rvbtn ${cur === s ? "on" : ""}" data-rvbtn="${s}" data-id="${escapeHtml(c.id)}">${REVIEW[s].icon} ${REVIEW[s].label}</button>`
  ).join("");
  return `<div class="memo-sec"><h4>Triage</h4><div class="rvbtns">${btns}<button class="rvbtn clear" data-rvbtn="" data-id="${escapeHtml(c.id)}">Clear</button></div></div>`;
}

function openMemo(id) {
  const c = state.byId[id];
  if (!c) return;
  const m = c.memo || {};
  const rec = c.recommendation;
  const raw = c.raw || {};
  const risks = (m.risks || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const recHtml = rec ? `
    <div class="rec ${VERDICT_CLASS[rec.verdict] || ""}">
      <div class="rec-top"><span class="rec-verdict">${escapeHtml(rec.verdict)}</span><span class="rec-conv">conviction ${fmtPct(rec.conviction)}</span></div>
      <p>${escapeHtml(rec.rationale || "")}</p>
    </div>` : "";
  const raised = raisedOf(c);
  const edgarUrl = raw.edgar_url || "";
  const filingUrl = raw.filing_url || edgarUrl;
  const ycUrl = raw.accelerator_url || "";
  const cta = `
    <div class="drawer-cta">
      ${c.website && c.website_verified ? `<a class="primary" href="${escapeHtml(c.website)}" target="_blank" rel="noopener">Visit website ↗</a>` : ""}
      ${filingUrl ? `<a href="${escapeHtml(filingUrl)}" target="_blank" rel="noopener">SEC Form D ↗</a>` : ""}
      ${edgarUrl ? `<a href="${escapeHtml(edgarUrl)}" target="_blank" rel="noopener">All EDGAR filings ↗</a>` : ""}
      ${ycUrl ? `<a href="${escapeHtml(ycUrl)}" target="_blank" rel="noopener">YC profile ↗</a>` : ""}
    </div>`;

  $("drawer").innerHTML = `
    <button class="close" aria-label="Close">×</button>
    <h2>${escapeHtml(c.name)} ${verifiedBadge(c)}</h2>
    <div class="memo-sub">${escapeHtml(m.one_liner || c.description || "")} <span class="badge-gen">${escapeHtml(m.generated_by || "heuristic")}</span></div>
    ${badgesHtml(c, 12)}
    ${recHtml}
    <div class="memo-grid">
      <div class="memo-kv"><div class="k">Financing signal</div><div class="v">${escapeHtml(financingOf(c))}</div></div>
      <div class="memo-kv"><div class="k">Stage</div><div class="v">${escapeHtml(stageOf(c) || "—")}</div></div>
      <div class="memo-kv"><div class="k">Capital raised</div><div class="v">${raised ? fmtMoney(raised) : "—"}</div></div>
      <div class="memo-kv"><div class="k">Category</div><div class="v">${escapeHtml(m.market_category || c.ai_category || "—")}</div></div>
    </div>
    ${evidencePanelHtml(c)}
    ${recommendedAction(c)}
    ${reviewActionsHtml(c)}
    ${foundersHtml(c.founders)}
    ${scoreBarsHtml(c.scores)}
    ${m.thesis ? `<div class="memo-sec"><h4>Investment thesis</h4><p>${escapeHtml(m.thesis)}</p></div>` : ""}
    ${competitiveHtml(c.competitive)}
    ${risks ? `<div class="memo-sec"><h4>Key risks</h4><ul>${risks}</ul></div>` : ""}
    ${verificationHtml(c)}
    ${cta}
  `;
  $("drawer").hidden = false;
  $("drawerOverlay").hidden = false;
  $("drawer").scrollTop = 0;
  $("drawer").querySelector(".close").addEventListener("click", closeMemo);
  $("drawer").querySelectorAll("[data-rvbtn]").forEach((b) =>
    b.addEventListener("click", () => { setReview(b.getAttribute("data-id"), b.getAttribute("data-rvbtn")); })
  );
}
function closeMemo() { $("drawer").hidden = true; $("drawerOverlay").hidden = true; }

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
document.addEventListener("click", (e) => { if (e.target.id === "drawerOverlay") closeMemo(); });

load();
