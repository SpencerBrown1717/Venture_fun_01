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
  initNetwork();
  renderHealth();
  renderTrends();
  renderBoard();
  updateRadarCount();
  updateFormdCount();
  updateReviewCount();
  updateWatchCount();
  updateInvestorCount();
  updateNetworkCount();
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
const TABS = ["all", "radar", "formd", "review", "board", "watch", "investors", "network"];
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
  });
  TABS.forEach((n) => { $("panel-" + n).hidden = n !== name; });
  if (name === "radar") renderRadar();
  if (name === "formd") renderFormd();
  if (name === "review") renderReview();
  if (name === "watch") renderWatch();
  if (name === "investors") renderInvestors();
  if (name === "network") renderNetwork();
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

// ===========================================================================
// WARM INTRO NETWORK (Part 3) — client-side only.
//   3a · parse Gmail / LinkedIn CSV exports + match against the dataset
//   3b · upload/paste intake + ranked warm-intro list
//   3c · radial relationship graph (SVG, on-theme)
// Contacts are parsed in the browser and never leave the page — same
// local-only model as the review queue. No backend, no upload.
// ===========================================================================

// --- 3a · robust CSV parser (quotes, embedded commas/newlines, "" escapes) -
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  text = String(text || "").replace(/^\uFEFF/, "");
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// LinkedIn prepends a "Notes:" preamble — locate the real header row by
// scoring each row on how many cells exactly look like known column names.
// (Prose lines that merely mention "email address" can't fake this.)
const HEADER_CELLS = new Set([
  "name", "full name", "display name", "middle name",
  "first name", "given name", "last name", "family name",
  "email", "e-mail", "email address", "e-mail address",
  "company", "organization", "organization name",
  "position", "title", "job title", "role",
  "url", "profile url", "linkedin", "connected on",
]);
function headerScore(cells) {
  let n = 0;
  for (const raw of cells) {
    const c = String(raw).toLowerCase().trim();
    if (HEADER_CELLS.has(c) || c.startsWith("e-mail 1") || c.startsWith("e-mail ") || c.startsWith("organization 1")) n++;
  }
  return n;
}
function findHeaderRow(rows) {
  let best = 0, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const sc = headerScore(rows[i]);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return bestScore >= 2 ? best : 0;
}

function pickCol(headers, candidates) {
  const low = headers.map((h) => String(h).toLowerCase().trim());
  for (const cand of candidates) { const idx = low.indexOf(cand); if (idx >= 0) return idx; }
  for (const cand of candidates) { const idx = low.findIndex((h) => h.includes(cand)); if (idx >= 0) return idx; }
  return -1;
}

const emailDomain = (e) => {
  const m = String(e || "").toLowerCase().match(/@([^@\s>]+)/);
  return m ? m[1].replace(/^www\./, "").replace(/[.,;]+$/, "") : "";
};
const FREEMAIL = new Set([
  "gmail.com","googlemail.com","yahoo.com","ymail.com","hotmail.com","outlook.com",
  "icloud.com","me.com","mac.com","aol.com","proton.me","protonmail.com","hey.com",
  "msn.com","live.com","gmx.com","fastmail.com","zoho.com","yandex.com",
]);

function rowsToContacts(rows) {
  if (!rows.length) return [];
  const h = findHeaderRow(rows);
  const headers = rows[h];
  const body = rows.slice(h + 1);
  const ci = {
    full:  pickCol(headers, ["name", "full name", "display name"]),
    first: pickCol(headers, ["first name", "given name"]),
    last:  pickCol(headers, ["last name", "family name"]),
    email: pickCol(headers, ["email address", "e-mail 1 - value", "e-mail address", "email", "e-mail"]),
    org:   pickCol(headers, ["company", "organization 1 - name", "organization name", "organization"]),
    title: pickCol(headers, ["position", "organization 1 - title", "organization title", "title", "job title", "role"]),
    url:   pickCol(headers, ["url", "profile url", "linkedin"]),
  };
  const get = (r, idx) => (idx >= 0 && idx < r.length ? String(r[idx]).trim() : "");
  const out = [];
  for (const r of body) {
    // Use the dedicated full-name column only when it isn't really the first/last
    // column (pickCol's fuzzy "name" match can resolve to "First Name"); otherwise
    // combine first + last so LinkedIn/Gmail exports yield a full name.
    let name = ci.full >= 0 && ci.full !== ci.first && ci.full !== ci.last ? get(r, ci.full) : "";
    if (!name) name = [get(r, ci.first), get(r, ci.last)].filter(Boolean).join(" ").trim();
    const email = get(r, ci.email).split(/[;, ]+/)[0].trim();
    const c = { name, email, emailDomain: emailDomain(email), company: get(r, ci.org), title: get(r, ci.title), url: get(r, ci.url) };
    if (c.name || c.email || c.company) out.push(c);
  }
  return out;
}

// --- 3a · normalization + dataset indices ----------------------------------
const stripAccents = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const normName = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const LEGAL = /\b(inc|incorporated|llc|l\s?l\s?c|corp|corporation|co|ltd|limited|company|holdings|group)\b/g;
const companyKey = (s) => normName(s).replace(LEGAL, " ").replace(/\s+/g, " ").trim();
function hostOf(url) {
  if (!url) return "";
  try { return new URL(/^https?:\/\//.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return String(url).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
}
const normalizeDomain = (d) => String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
const companyDomain = (c) => normalizeDomain(c.domain) || hostOf(c.website || "");

function buildNetIndex() {
  if (state.netIndex) return state.netIndex;
  const byDomain = new Map(), byCompanyKey = new Map(), byFounder = new Map();
  const push = (map, k, v) => { (map.get(k) || map.set(k, []).get(k)).push(v); };
  for (const c of state.companies) {
    const dom = companyDomain(c);
    if (dom && !byDomain.has(dom)) byDomain.set(dom, c);
    const ck = companyKey(c.name);
    if (ck && ck.length >= 3) push(byCompanyKey, ck, c);
    for (const f of (c.founders || [])) {
      const nn = normName(f.name);
      const toks = nn.split(" ").filter(Boolean);
      if (toks.length >= 2 && toks[0].length >= 2 && toks[toks.length - 1].length >= 2) push(byFounder, nn, { company: c, founder: f });
    }
  }
  state.netIndex = { byDomain, byCompanyKey, byFounder };
  return state.netIndex;
}

// --- 3a · matching engine --------------------------------------------------
const PATH = {
  domain:   { label: "Works there",    sub: "email domain matches company domain", cls: "p-domain",   icon: "◉", precise: true  },
  founder:  { label: "Knows founder",  sub: "name matches a founder in an SEC filing", cls: "p-founder",  icon: "★", precise: false },
  employer: { label: "Lists employer", sub: "contact's employer field matches company", cls: "p-employer", icon: "▣", precise: false },
};
const PATH_ORDER = { domain: 0, founder: 1, employer: 2 };

function matchContacts(contacts) {
  const { byDomain, byCompanyKey, byFounder } = buildNetIndex();
  const matches = [], seen = new Set();
  contacts.forEach((ct, idx) => {
    const add = (company, type, why) => {
      const key = idx + "|" + company.id + "|" + type;
      if (seen.has(key)) return;
      seen.add(key);
      matches.push({ contact: ct, contactIdx: idx, company, type, why });
    };
    if (ct.emailDomain && !FREEMAIL.has(ct.emailDomain) && byDomain.has(ct.emailDomain)) {
      add(byDomain.get(ct.emailDomain), "domain", `${ct.email} is on @${ct.emailDomain}`);
    }
    const nn = normName(ct.name);
    if (nn && byFounder.has(nn)) {
      for (const { company, founder } of byFounder.get(nn))
        add(company, "founder", `${ct.name} matches ${founder.name}${founder.role ? ", " + founder.role : ""}`);
    }
    const ck = companyKey(ct.company);
    if (ck && ck.length >= 3 && byCompanyKey.has(ck)) {
      for (const co of byCompanyKey.get(ck)) add(co, "employer", `lists “${ct.company}” as employer`);
    }
  });
  return collapseMatches(matches);
}
// Drop the weaker "employer" path when a precise "domain" path exists for the same pair.
function collapseMatches(matches) {
  const hasDomain = new Set(matches.filter((m) => m.type === "domain").map((m) => m.contactIdx + "|" + m.company.id));
  return matches.filter((m) => !(m.type === "employer" && hasDomain.has(m.contactIdx + "|" + m.company.id)));
}

function netTargets() {
  const byCo = new Map();
  for (const m of state.matches) {
    const id = m.company.id;
    if (!byCo.has(id)) byCo.set(id, { company: m.company, paths: [] });
    byCo.get(id).paths.push(m);
  }
  let targets = [...byCo.values()];
  if (state.netAiOnly) targets = targets.filter((t) => t.company.is_ai);
  targets.forEach((t) => t.paths.sort((a, b) => PATH_ORDER[a.type] - PATH_ORDER[b.type]));
  targets.sort((a, b) => oppOf(b.company) - oppOf(a.company) || b.paths.length - a.paths.length);
  return targets;
}

// --- 3b · intake (upload / paste / sample) ---------------------------------
function initNetwork() {
  state.contacts = []; state.matches = []; state.netIndex = null; state.netAiOnly = true;
  const drop = $("netDrop");
  $("netBrowse").addEventListener("click", () => $("netFile").click());
  $("netFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) readFileToMatch(f); e.target.value = ""; });
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("drag");
    const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) readFileToMatch(f);
  });
  $("netMatch").addEventListener("click", () => ingest($("netPaste").value, "pasted text"));
  $("netSample").addEventListener("click", () => { $("netPaste").value = ""; ingest(sampleContacts(), "sample contacts"); });
  $("netClear").addEventListener("click", () => {
    state.contacts = []; state.matches = []; $("netPaste").value = "";
    $("netStatus").hidden = true; updateNetworkCount(); renderNetwork();
  });
  $("netAiOnly").addEventListener("change", (e) => { state.netAiOnly = e.target.checked; renderNetwork(); });
}

function readFileToMatch(file) {
  const fr = new FileReader();
  fr.onload = () => ingest(String(fr.result || ""), file.name);
  fr.onerror = () => setNetStatus("Could not read that file.", true);
  fr.readAsText(file);
}

function ingest(text, label) {
  if (!String(text || "").trim()) { setNetStatus("Nothing to parse — paste CSV rows or choose a file.", true); return; }
  let contacts;
  try { contacts = rowsToContacts(parseCsv(text)); }
  catch (_) { setNetStatus("Could not parse that CSV.", true); return; }
  if (!contacts.length) { setNetStatus(`Parsed ${escapeHtml(label)}, but found no contact rows — expecting a Gmail or LinkedIn CSV export.`, true); return; }
  state.contacts = contacts;
  state.matches = matchContacts(contacts);
  // Build 1/3 — run the investor intro matching engine on the same contacts.
  // Map the dashboard's vc_deals investor shape (lead_partners / profile.website /
  // companies / focus) into the universe shape the matcher expects.
  const investorUniverse = buildInvestorUniverse({
    companies: state.companies || [],
    investors: ((state.vc && state.vc.investors) || []).map((inv) => {
      const site = (inv.profile && inv.profile.website) || "";
      return {
        name: inv.name,
        website: site,
        domain: site ? hostOf(site) : "",
        thesisTags: inv.focus || [],
        partners: (inv.lead_partners || []).map((p) => ({ name: p.name, linkedin: p.linkedin, x: p.x, title: "Partner" })),
        portfolioCompanies: (inv.companies || []).map((c) => (typeof c === "string" ? c : c && c.name)).filter(Boolean),
      };
    }),
    partners: []
  });
  const investorIntroMatches = buildInvestorIntroMatches(contacts, investorUniverse);
  const superConnectors = buildSuperConnectors({ startupIntroMatches: state.matches, investorIntroMatches });
  const enrichedCompanies = attachInvestorAccessToCompanies(state.companies || [], investorIntroMatches);
  state.warmIntroMatches = state.matches;
  state.investorUniverse = investorUniverse;
  state.investorIntroMatches = investorIntroMatches;
  state.superConnectors = superConnectors;
  state.enrichedCompanies = enrichedCompanies;
  console.info("[network] investor universe", investorUniverse.length);
  console.info("[network] investor intro matches", investorIntroMatches.length);
  console.info("[network] super connectors", superConnectors.length);
  const reach = new Set(state.matches.map((m) => m.company.id)).size;
  setNetStatus(`Parsed ${contacts.length} contacts from ${escapeHtml(label)} · ${state.matches.length} warm path${state.matches.length === 1 ? "" : "s"} into ${reach} compan${reach === 1 ? "y" : "ies"}. Contacts stayed in your browser.`, false);
  updateNetworkCount();
  switchTab("network");
}

function setNetStatus(msg, isErr) {
  const el = $("netStatus");
  el.hidden = false; el.textContent = msg;
  el.className = "net-status" + (isErr ? " err" : "");
}
function updateNetworkCount() { $("networkCount").textContent = new Set(state.matches.map((m) => m.company.id)).size; }

// Synthesize a demo CSV from the loaded dataset so the feature always lights up
// without anyone uploading personal data.
function sampleContacts() {
  const lines = ["First Name,Last Name,Email Address,Company,Position,Connected On"];
  const isFull = (n) => normName(n).split(" ").filter(Boolean).length >= 2;
  state.companies.filter((c) => c.is_ai && (c.founders || []).some((f) => isFull(f.name))).slice(0, 8).forEach((c) => {
    const f = c.founders.find((f) => isFull(f.name));
    const p = f.name.split(/\s+/);
    lines.push([csvCell(p[0]), csvCell(p.slice(1).join(" ")), "", csvCell(c.name), csvCell(f.role || "Founder"), "2024"].join(","));
  });
  state.companies.filter((c) => companyDomain(c)).slice(0, 5).forEach((c) => {
    lines.push(["Alex", "Rivera", "alex@" + companyDomain(c), csvCell(c.name), "Engineering", "2023"].join(","));
  });
  // Investor-side synthetic contacts — demonstrate investor + partner access in
  // the graph (uses real firm names from the deals export; clearly a demo).
  const vcFirms = ((state.vc && state.vc.investors) || []).filter((f) => f && f.name);
  vcFirms.slice(0, 4).forEach((f, i) => {
    const lp = (f.lead_partners || [])[0];
    if (lp && lp.name) {
      const parts = String(lp.name).split(/\s+/);
      lines.push([csvCell(parts[0]), csvCell(parts.slice(1).join(" ")), "", csvCell(f.name), "Partner", "2023"].join(","));
    } else {
      lines.push([(["Sam", "Robin", "Jess", "Lee"][i] || "Casey"), "Lane", "", csvCell(f.name), "Investor", "2023"].join(","));
    }
  });
  lines.push("Jordan,Lee,jordan.lee@gmail.com,Acme Co,Designer,2022");
  lines.push("Sam,Patel,sam@unrelated.io,Unrelated Holdings,Analyst,2021");
  return lines.join("\n");
}
const csvCell = (s) => { s = String(s ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/* =========================================================
   Network v16 — Investor Intro Matching Engine
   Build 1/3: data + matching layer only
   ========================================================= */

const INVESTOR_TITLE_KEYWORDS = [
  "vc",
  "venture",
  "ventures",
  "capital",
  "investor",
  "investment",
  "partner",
  "principal",
  "associate",
  "scout",
  "analyst",
  "fund",
  "growth",
  "seed",
  "pre-seed",
  "accelerator"
];

const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com"
]);

function safeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .replace(/[^a-z0-9. -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(llc|inc|co|company|corp|corporation|ltd|limited|management|partners|partner|ventures|venture|capital|fund|funds)\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getEmailDomain(email) {
  const raw = safeText(email).toLowerCase();
  if (!raw.includes("@")) return "";
  return raw.split("@").pop().trim();
}

function isFreemailDomain(domain) {
  return FREEMAIL_DOMAINS.has(normalizeKey(domain));
}

function includesNormalized(haystack, needle) {
  const h = normalizeKey(haystack);
  const n = normalizeKey(needle);
  return Boolean(h && n && h.includes(n));
}

function hasInvestorTitleSignal(contact) {
  const title = normalizeKey(
    [
      contact.title,
      contact.headline,
      contact.position,
      contact.role,
      contact.notes
    ].filter(Boolean).join(" ")
  );

  return INVESTOR_TITLE_KEYWORDS.some((keyword) =>
    title.includes(keyword)
  );
}

function contactFullText(contact) {
  return normalizeKey(
    [
      contact.name,
      contact.firstName,
      contact.lastName,
      contact.email,
      contact.company,
      contact.employer,
      contact.organization,
      contact.title,
      contact.role,
      contact.headline,
      contact.linkedin,
      contact.website,
      contact.notes
    ].filter(Boolean).join(" ")
  );
}

function getContactName(contact) {
  const explicit = safeText(contact.name || contact.fullName);
  if (explicit) return explicit;

  const first = safeText(contact.firstName);
  const last = safeText(contact.lastName);
  return [first, last].filter(Boolean).join(" ") || "Unknown contact";
}

function getContactCompany(contact) {
  return safeText(
    contact.company ||
    contact.employer ||
    contact.organization ||
    contact.currentCompany ||
    ""
  );
}

function getContactTitle(contact) {
  return safeText(
    contact.title ||
    contact.role ||
    contact.position ||
    contact.headline ||
    ""
  );
}

function getContactEmail(contact) {
  return safeText(contact.email || contact.emailAddress || contact.workEmail || "");
}

function getContactLinkedIn(contact) {
  return safeText(contact.linkedin || contact.linkedIn || contact.linkedinUrl || contact.url || "");
}

/**
 * Builds investor records from whatever data is already available.
 *
 * Accepts:
 * - existing investors array, if present
 * - company records that contain investor fields
 * - manually defined partner records, if present
 *
 * This should be defensive because data.json may evolve.
 */
function buildInvestorUniverse({ companies = [], investors = [], partners = [] } = {}) {
  const firmMap = new Map();

  function upsertFirm(rawFirm) {
    const name = safeText(rawFirm.name || rawFirm.firm || rawFirm.investor || rawFirm.investorName);
    if (!name) return null;

    const key = normalizeName(name);
    if (!key) return null;

    const existing = firmMap.get(key) || {
      name,
      normalizedName: key,
      domain: "",
      website: "",
      thesisTags: [],
      partners: [],
      portfolioCompanies: [],
      sourceRecords: []
    };

    existing.name = existing.name || name;
    existing.domain = existing.domain || safeText(rawFirm.domain || rawFirm.emailDomain || "");
    existing.website = existing.website || safeText(rawFirm.website || rawFirm.url || "");
    existing.thesisTags = Array.from(new Set([
      ...existing.thesisTags,
      ...asArray(rawFirm.thesisTags),
      ...asArray(rawFirm.focus),
      ...asArray(rawFirm.categories)
    ].map(safeText).filter(Boolean)));

    existing.sourceRecords.push(rawFirm);
    firmMap.set(key, existing);
    return existing;
  }

  function addPartnerToFirm(firm, rawPartner) {
    if (!firm || !rawPartner) return;

    const partnerName = safeText(rawPartner.name || rawPartner.partner || rawPartner.fullName);
    if (!partnerName) return;

    const partner = {
      name: partnerName,
      title: safeText(rawPartner.title || rawPartner.role || ""),
      linkedin: safeText(rawPartner.linkedin || rawPartner.linkedinUrl || ""),
      x: safeText(rawPartner.x || rawPartner.twitter || ""),
      focus: asArray(rawPartner.focus || rawPartner.thesisTags || rawPartner.categories)
        .map(safeText)
        .filter(Boolean)
    };

    const existingKey = normalizeName(partner.name);
    const alreadyExists = firm.partners.some((p) => normalizeName(p.name) === existingKey);
    if (!alreadyExists) firm.partners.push(partner);
  }

  investors.forEach((investor) => {
    const firm = upsertFirm(investor);

    asArray(investor.partners).forEach((partner) => {
      addPartnerToFirm(firm, partner);
    });

    asArray(investor.portfolioCompanies).forEach((companyName) => {
      const clean = safeText(companyName);
      if (clean && !firm.portfolioCompanies.includes(clean)) {
        firm.portfolioCompanies.push(clean);
      }
    });
  });

  partners.forEach((partner) => {
    const firmName = safeText(partner.firm || partner.investor || partner.investorFirm);
    const firm = upsertFirm({ name: firmName });
    addPartnerToFirm(firm, partner);
  });

  companies.forEach((company) => {
    const companyName = safeText(company.name || company.company || company.title);

    const knownInvestors = [
      ...asArray(company.investors),
      ...asArray(company.knownInvestors),
      ...asArray(company.possibleInvestors),
      ...asArray(company.backers),
      ...asArray(company.firms)
    ];

    knownInvestors.forEach((raw) => {
      const firmName = typeof raw === "string"
        ? raw
        : safeText(raw.name || raw.firm || raw.investor);

      const firm = upsertFirm(typeof raw === "string" ? { name: raw } : raw);
      if (firm && companyName && !firm.portfolioCompanies.includes(companyName)) {
        firm.portfolioCompanies.push(companyName);
      }

      if (firm && typeof raw === "object") {
        asArray(raw.partners).forEach((partner) => {
          addPartnerToFirm(firm, partner);
        });
      }
    });
  });

  return Array.from(firmMap.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(/[;,|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
}

/**
 * Main investor matching function.
 *
 * Inputs:
 * - contacts: parsed contacts from Gmail / LinkedIn CSV
 * - investorUniverse: normalized investor firm records
 *
 * Output:
 * - investor intro matches
 */
function buildInvestorIntroMatches(contacts = [], investorUniverse = []) {
  const matches = [];

  contacts.forEach((contact) => {
    const contactName = getContactName(contact);
    const contactEmail = getContactEmail(contact);
    const contactDomain = getEmailDomain(contactEmail);
    const contactCompany = getContactCompany(contact);
    const contactTitle = getContactTitle(contact);
    const contactLinkedIn = getContactLinkedIn(contact);
    const contactText = contactFullText(contact);

    investorUniverse.forEach((firm) => {
      const firmName = safeText(firm.name);
      const firmDomain = normalizeKey(firm.domain || domainFromWebsite(firm.website));
      const firmNameNorm = normalizeName(firmName);
      const contactCompanyNorm = normalizeName(contactCompany);

      const signals = [];
      const sourceFields = [];
      let verified = false;

      if (contactCompanyNorm && firmNameNorm && contactCompanyNorm === firmNameNorm) {
        signals.push("employer_exact_match");
        sourceFields.push("contact.company");
        verified = true;
      }

      if (
        contactCompanyNorm &&
        firmNameNorm &&
        (contactCompanyNorm.includes(firmNameNorm) || firmNameNorm.includes(contactCompanyNorm))
      ) {
        signals.push("employer_fuzzy_match");
        sourceFields.push("contact.company");
      }

      if (
        contactDomain &&
        firmDomain &&
        !isFreemailDomain(contactDomain) &&
        contactDomain === firmDomain
      ) {
        signals.push("email_domain_match");
        sourceFields.push("contact.email");
        verified = true;
      }

      if (firmName && includesNormalized(contact.notes, firmName)) {
        signals.push("notes_mention_firm");
        sourceFields.push("contact.notes");
      }

      if (firmName && includesNormalized(contactTitle, firmName)) {
        signals.push("title_mentions_firm");
        sourceFields.push("contact.title");
      }

      if (hasInvestorTitleSignal(contact)) {
        signals.push("title_vc_keyword");
        sourceFields.push("contact.title");
      }

      const matchedPartner = findBestPartnerMatch(contact, firm);

      if (matchedPartner) {
        signals.push(...matchedPartner.signals);
        sourceFields.push(...matchedPartner.sourceFields);
        if (matchedPartner.verified) verified = true;
      }

      const strongEnough =
        signals.includes("employer_exact_match") ||
        signals.includes("email_domain_match") ||
        signals.includes("partner_name_match") ||
        (
          signals.includes("employer_fuzzy_match") &&
          signals.includes("title_vc_keyword")
        ) ||
        (
          signals.includes("notes_mention_firm") &&
          signals.includes("title_vc_keyword")
        );

      if (!strongEnough) return;

      const confidence = investorConfidenceFromSignals(signals, verified);
      const investorAccessScore = computeInvestorAccessScore({
        signals,
        verified,
        confidence,
        contact,
        firm,
        partner: matchedPartner && matchedPartner.partner
      });

      const partner = matchedPartner && matchedPartner.partner;

      matches.push({
        type: "investor_intro",
        contactName,
        contactEmail,
        contactLinkedIn,
        contactTitle,
        contactCompany,
        targetInvestor: firm.name,
        targetInvestorDomain: firmDomain,
        targetPartner: partner ? partner.name : "",
        targetPartnerTitle: partner ? safeText(partner.title) : "",
        relationshipPath: [
          "You",
          contactName,
          firm.name,
          ...(partner ? [partner.name] : [])
        ],
        matchReason: investorMatchReason(signals, firm, partner),
        matchSignals: Array.from(new Set(signals)),
        sourceFields: Array.from(new Set(sourceFields)),
        confidence,
        verified,
        investorAccessScore,
        recommendedAsk: buildInvestorRecommendedAsk({
          contactName,
          firm,
          partner,
          confidence
        })
      });
    });
  });

  return dedupeInvestorIntroMatches(matches)
    .sort((a, b) => b.investorAccessScore - a.investorAccessScore);
}

function domainFromWebsite(website) {
  const raw = normalizeKey(website);
  if (!raw) return "";
  return raw.split("/")[0].replace(/^www\./, "");
}

function findBestPartnerMatch(contact, firm) {
  const text = contactFullText(contact);
  const company = normalizeName(getContactCompany(contact));
  const email = normalizeKey(getContactEmail(contact));
  const linkedin = normalizeKey(getContactLinkedIn(contact));

  let best = null;

  asArray(firm.partners).forEach((partner) => {
    const partnerName = safeText(partner.name);
    const partnerNameNorm = normalizeName(partnerName);
    const partnerLinkedIn = normalizeKey(partner.linkedin);

    const signals = [];
    const sourceFields = [];
    let verified = false;

    if (partnerNameNorm && text.includes(partnerNameNorm)) {
      signals.push("partner_name_match");
      sourceFields.push("contact.full_text");
    }

    if (partnerLinkedIn && linkedin && partnerLinkedIn === linkedin) {
      signals.push("partner_linkedin_exact_match");
      sourceFields.push("contact.linkedin");
      verified = true;
    }

    if (partnerNameNorm && company && company.includes(partnerNameNorm)) {
      signals.push("partner_name_in_company_field");
      sourceFields.push("contact.company");
    }

    if (!signals.length) return;

    const score =
      (signals.includes("partner_linkedin_exact_match") ? 50 : 0) +
      (signals.includes("partner_name_match") ? 30 : 0) +
      (signals.includes("partner_name_in_company_field") ? 15 : 0);

    if (!best || score > best.score) {
      best = {
        partner,
        signals,
        sourceFields,
        verified,
        score
      };
    }
  });

  return best;
}

function investorConfidenceFromSignals(signals, verified) {
  const set = new Set(signals);

  if (
    verified &&
    (
      set.has("email_domain_match") ||
      set.has("employer_exact_match") ||
      set.has("partner_linkedin_exact_match")
    )
  ) {
    return "high";
  }

  if (
    set.has("partner_name_match") ||
    (
      set.has("employer_fuzzy_match") &&
      set.has("title_vc_keyword")
    )
  ) {
    return "medium";
  }

  if (
    set.has("notes_mention_firm") ||
    set.has("title_mentions_firm")
  ) {
    return "medium";
  }

  return "low";
}

function computeInvestorAccessScore({ signals, verified, confidence, contact, firm, partner }) {
  const set = new Set(signals);
  let score = 30;

  if (verified) score += 20;
  if (confidence === "high") score += 20;
  if (confidence === "medium") score += 10;

  if (set.has("email_domain_match")) score += 18;
  if (set.has("employer_exact_match")) score += 18;
  if (set.has("partner_linkedin_exact_match")) score += 20;
  if (set.has("partner_name_match")) score += 12;
  if (set.has("title_vc_keyword")) score += 8;
  if (set.has("notes_mention_firm")) score += 6;

  if (getContactEmail(contact)) score += 4;
  if (getContactLinkedIn(contact)) score += 4;
  if (partner && partner.name) score += 8;
  if (asArray(firm.portfolioCompanies).length > 0) score += 4;
  if (asArray(firm.thesisTags).length > 0) score += 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function investorMatchReason(signals, firm, partner) {
  const set = new Set(signals);

  if (set.has("partner_linkedin_exact_match")) {
    return `Contact LinkedIn matched ${partner.name}.`;
  }

  if (set.has("email_domain_match")) {
    return `Contact email domain matched ${firm.name}.`;
  }

  if (set.has("employer_exact_match")) {
    return `Contact employer matched ${firm.name}.`;
  }

  if (set.has("partner_name_match")) {
    return `Contact record mentions partner ${partner.name}.`;
  }

  if (set.has("employer_fuzzy_match") && set.has("title_vc_keyword")) {
    return `Contact employer appears related to ${firm.name}, with investor-title signal.`;
  }

  if (set.has("notes_mention_firm")) {
    return `Contact notes mention ${firm.name}.`;
  }

  return `Contact appears connected to ${firm.name}.`;
}

function buildInvestorRecommendedAsk({ contactName, firm, partner, confidence }) {
  const partnerPhrase = partner && partner.name
    ? `${partner.name}${partner.title ? `, ${partner.title}` : ""}`
    : `the right partner`;

  if (confidence === "high") {
    return `Ask ${contactName} whether ${partnerPhrase} at ${firm.name} is the right person for this category.`;
  }

  if (confidence === "medium") {
    return `Ask ${contactName} whether they know the right person at ${firm.name} for early AI opportunities.`;
  }

  return `Ask ${contactName} to confirm whether they have a real connection to ${firm.name} before requesting an intro.`;
}

function dedupeInvestorIntroMatches(matches) {
  const seen = new Map();

  matches.forEach((match) => {
    const key = [
      normalizeName(match.contactName),
      normalizeKey(match.contactEmail),
      normalizeName(match.targetInvestor),
      normalizeName(match.targetPartner)
    ].join("|");

    const existing = seen.get(key);

    if (!existing || match.investorAccessScore > existing.investorAccessScore) {
      seen.set(key, match);
    }
  });

  return Array.from(seen.values());
}

/**
 * Super-connectors are contacts who connect to multiple valuable nodes.
 *
 * This works across startup intro matches and investor intro matches.
 */
function buildSuperConnectors({ startupIntroMatches = [], investorIntroMatches = [] } = {}) {
  const connectorMap = new Map();

  function ensureConnector(match) {
    // Investor matches carry contactName/contactEmail; real startup matches carry
    // the contact at match.contact.{name,email}. Support both shapes.
    const name = safeText(match.contactName || match.connectorName || match.name || (match.contact && match.contact.name));
    const email = safeText(match.contactEmail || match.email || (match.contact && match.contact.email));
    const key = normalizeKey(email || name);

    if (!key) return null;

    if (!connectorMap.has(key)) {
      connectorMap.set(key, {
        contactName: name,
        contactEmail: email,
        startupTargets: new Set(),
        investorTargets: new Set(),
        partnerTargets: new Set(),
        paths: [],
        bestScore: 0,
        connectorType: "unknown"
      });
    }

    return connectorMap.get(key);
  }

  startupIntroMatches.forEach((match) => {
    const connector = ensureConnector(match);
    if (!connector) return;

    // Real startup matches (state.matches) carry `company` as an object {id,name,scores}.
    const company = safeText(
      match.targetCompany || (match.company && match.company.name) || match.companyName || match.company
    );
    if (company) connector.startupTargets.add(company);

    connector.paths.push(match);
    connector.bestScore = Math.max(
      connector.bestScore,
      Number(match.founderAccessScore || match.introScore || (match.company && match.company.scores && match.company.scores.overall) || 0)
    );
  });

  investorIntroMatches.forEach((match) => {
    const connector = ensureConnector(match);
    if (!connector) return;

    if (match.targetInvestor) connector.investorTargets.add(match.targetInvestor);
    if (match.targetPartner) connector.partnerTargets.add(match.targetPartner);

    connector.paths.push(match);
    connector.bestScore = Math.max(
      connector.bestScore,
      Number(match.investorAccessScore || 0)
    );
  });

  return Array.from(connectorMap.values())
    .map((connector) => {
      const startupCount = connector.startupTargets.size;
      const investorCount = connector.investorTargets.size;
      const partnerCount = connector.partnerTargets.size;

      let connectorType = "single_path_connector";

      if (startupCount > 0 && investorCount > 0) {
        connectorType = "bridge_super_connector";
      } else if (startupCount >= 2) {
        connectorType = "founder_side_super_connector";
      } else if (investorCount >= 2 || partnerCount >= 2) {
        connectorType = "investor_side_super_connector";
      }

      const leverageScore =
        connector.bestScore +
        startupCount * 8 +
        investorCount * 10 +
        partnerCount * 6 +
        (connectorType === "bridge_super_connector" ? 20 : 0);

      return {
        contactName: connector.contactName,
        contactEmail: connector.contactEmail,
        startupTargets: Array.from(connector.startupTargets),
        investorTargets: Array.from(connector.investorTargets),
        partnerTargets: Array.from(connector.partnerTargets),
        pathCount: connector.paths.length,
        connectorType,
        leverageScore: Math.min(100, Math.round(leverageScore)),
        recommendedAction: buildSuperConnectorAction({
          name: connector.contactName,
          startupCount,
          investorCount,
          partnerCount,
          connectorType
        })
      };
    })
    // A real super-connector reaches >= 2 distinct valuable nodes (startups +
    // investor firms) — not just one company via two path types.
    .filter((connector) => (connector.startupTargets.length + connector.investorTargets.length) >= 2)
    .sort((a, b) => b.leverageScore - a.leverageScore);
}

function buildSuperConnectorAction({ name, startupCount, investorCount, partnerCount, connectorType }) {
  if (connectorType === "bridge_super_connector") {
    return `Ask ${name} for category-level feedback first; they may bridge both startup and investor access.`;
  }

  if (connectorType === "founder_side_super_connector") {
    return `Ask ${name} which of the ${startupCount} connected startups is most worth prioritizing.`;
  }

  if (connectorType === "investor_side_super_connector") {
    return `Ask ${name} which investor or partner is closest to this category.`;
  }

  return `Ask ${name} to confirm the relationship before requesting a specific intro.`;
}

/**
 * Optional helper:
 * Enrich company records with investor access.
 *
 * This lets the next build show:
 * - Founder Access Score
 * - Investor Access Score
 * - Total Access Score
 */
function attachInvestorAccessToCompanies(companies = [], investorIntroMatches = []) {
  return companies.map((company) => {
    const companyName = safeText(company.name || company.company || company.title);
    const companyInvestors = [
      ...asArray(company.investors),
      ...asArray(company.knownInvestors),
      ...asArray(company.possibleInvestors),
      ...asArray(company.backers)
    ].map((item) => {
      if (typeof item === "string") return item;
      return safeText(item.name || item.firm || item.investor);
    }).filter(Boolean);

    const relatedInvestorMatches = investorIntroMatches.filter((match) => {
      return companyInvestors.some((investorName) =>
        normalizeName(investorName) === normalizeName(match.targetInvestor)
      );
    });

    const investorAccessScore = relatedInvestorMatches.length
      ? Math.max(...relatedInvestorMatches.map((m) => Number(m.investorAccessScore || 0)))
      : 0;

    const founderAccessScore = Number(company.founderAccessScore || company.introScore || 0);
    const opportunityScore = Number(company.score || company.opportunityScore || company.aiScore || 0);

    const totalAccessScore = Math.min(
      100,
      Math.round(
        founderAccessScore * 0.35 +
        investorAccessScore * 0.35 +
        opportunityScore * 0.30
      )
    );

    return {
      ...company,
      investorIntroMatches: relatedInvestorMatches,
      investorAccessScore,
      totalAccessScore,
      accessLabel: accessLabelFromScores({
        founderAccessScore,
        investorAccessScore,
        totalAccessScore
      })
    };
  });
}

function accessLabelFromScores({ founderAccessScore, investorAccessScore, totalAccessScore }) {
  if (founderAccessScore >= 75 && investorAccessScore >= 75) {
    return "A+ — Strong founder and investor access";
  }

  if (founderAccessScore >= 75) {
    return "A — Strong founder access";
  }

  if (investorAccessScore >= 75) {
    return "A — Strong investor access";
  }

  if (totalAccessScore >= 60) {
    return "B — Useful path, needs verification";
  }

  return "C — Weak or missing access path";
}

// --- 3b · render warm-intro list -------------------------------------------
function renderNetwork() {
  const has = state.contacts.length > 0;
  $("netEmpty").hidden = has;
  $("netStrip").hidden = !has;
  $("netGraphWrap").hidden = !has;
  // Saved targets persist independent of any match — always render them (Build 3/3).
  const actionGrid = document.getElementById("netActionGrid");
  if (actionGrid) actionGrid.hidden = !has;
  renderNetworkTargets();
  if (!has) { $("netList").innerHTML = ""; $("netGraph").innerHTML = ""; return; }

  const targets = netTargets();
  const uniqConnectors = new Set(state.matches.map((m) => m.contactIdx)).size;
  const founderPaths = state.matches.filter((m) => m.type === "founder").length;

  const strip = [
    { num: state.contacts.length, lbl: "Contacts parsed" },
    { num: uniqConnectors, lbl: "Warm connectors", accent: true },
    { num: targets.length, lbl: state.netAiOnly ? "AI companies reachable" : "Companies reachable", accent: true },
    { num: founderPaths, lbl: "Founder paths" },
  ];
  // Build 1/3 debug stats — confirm the investor data layer ran (only after a match).
  if (state.investorUniverse && state.investorUniverse.length) {
    const introMatches = state.investorIntroMatches || [];
    strip.push(
      { num: state.investorUniverse.length, lbl: "Investor firms" },
      { num: introMatches.length, lbl: "Investor paths", accent: true },
      { num: introMatches.filter((m) => m.targetPartner).length, lbl: "Partner paths" },
      { num: (state.superConnectors || []).length, lbl: "Super-connectors", accent: true },
    );
  }
  $("netStrip").innerHTML = strip.map((c) =>
    `<div class="hstat"><div class="hnum ${c.accent ? "accent" : ""}">${escapeHtml(c.num)}</div><div class="hlbl">${escapeHtml(c.lbl)}</div></div>`).join("");

  // Build 2/3 — unified graph (startup + investor paths). Shown whenever either exists.
  const introCount = (state.investorIntroMatches || []).length;
  const hasGraph = targets.length > 0 || introCount > 0;
  $("netGraphWrap").hidden = !hasGraph;
  if (hasGraph) renderNetworkGraphFromState(); else $("netGraph").innerHTML = "";

  // Build 3/3 — investor + super-connector cards render right after the graph.
  renderNetworkActionLayerFromState();

  if (!targets.length) {
    $("netList").innerHTML = introCount
      ? `<div class="empty">No startup paths from these contacts, but ${introCount} investor path${introCount === 1 ? "" : "s"} — explore the graph above.</div>`
      : `<div class="empty">Parsed ${state.contacts.length} contacts, but none match ${state.netAiOnly ? "an AI " : "a "}company in the dataset yet. Try toggling “AI only”, or import a fuller export.</div>`;
    return;
  }
  $("netList").innerHTML = targets.map(targetCardHtml).join("");
  $("netList").querySelectorAll("[data-memo]").forEach((b) =>
    b.addEventListener("click", (e) => { if (e.target.closest("a") || e.target.closest("button")) return; openMemo(b.getAttribute("data-memo")); }));
  const targetFor = (id) => netTargets().find((t) => t.company.id === id);
  $("netList").querySelectorAll("[data-copy-startup-draft]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const t = targetFor(b.getAttribute("data-company-id")); if (t) copyTextWithFeedback(buildStartupDraft(t), b); }));
  $("netList").querySelectorAll("[data-save-company-target]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); const t = targetFor(b.getAttribute("data-company-id")); if (t) { saveNetworkTarget("company", companyTargetFromStartupMatch(t)); copyButtonFeedback(b, "Saved ✓"); } }));
}

function targetCardHtml(t) {
  const c = t.company;
  const rows = t.paths.map((m) => {
    const p = PATH[m.type], ct = m.contact, links = [];
    if (ct.url) links.push(`<a href="${escapeHtml(ct.url)}" target="_blank" rel="noopener">profile ↗</a>`);
    if (ct.email) links.push(`<a href="mailto:${escapeHtml(ct.email)}">email ↗</a>`);
    return `<div class="net-path ${p.cls}">
      <span class="np-ico" title="${escapeHtml(p.sub)}">${p.icon}</span>
      <div class="np-body">
        <div class="np-name">${escapeHtml(ct.name || ct.email || "Unknown contact")}
          <span class="np-tag">${escapeHtml(p.label)}</span>
          ${p.precise ? `<span class="np-tag precise">verified path</span>` : `<span class="np-tag infer">match — confirm identity</span>`}
        </div>
        <div class="np-why">${escapeHtml(m.why)}${ct.title ? ` · ${escapeHtml(ct.title)}` : ""}</div>
      </div>
      <div class="np-links">${links.join("")}</div>
    </div>`;
  }).join("");
  const cat = c.ai_category ? `<span class="tag cat">${escapeHtml(c.ai_category)}</span>` : "";
  return `
    <div class="card net-target" data-memo="${escapeHtml(c.id)}">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(c.name)} ${verifiedBadge(c)}</h3>
          <div class="sub">${escapeHtml(c.jurisdiction || "—")} · ${escapeHtml(financingOf(c))}</div>
        </div>
        ${c.scores ? `<div class="opp-badge"><div class="v">${c.scores.overall}</div><div class="l">opp</div></div>` : ""}
      </div>
      <div class="tags">${cat}<span class="pill-meta">${t.paths.length} warm ${t.paths.length === 1 ? "path" : "paths"}</span></div>
      <div class="net-paths">${rows}</div>
      <div class="intro-actions startup-card-actions">
        <button class="ghost-button small" type="button" data-copy-startup-draft data-company-id="${escapeHtml(c.id)}">Copy founder ask</button>
        <button class="ghost-button small" type="button" data-save-company-target data-company-id="${escapeHtml(c.id)}">Save company</button>
      </div>
    </div>`;
}

// --- 3c · relationship graph (SVG) -----------------------------------------
const truncate = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function drawNetGraph(allTargets) {
  const targets = allTargets.slice(0, 16);
  if (!targets.length) { $("netGraph").innerHTML = ""; return; }

  const W = 920, H = 540, cx = W / 2, cy = H / 2, Rco = 205, Rct = 108;

  const order = [], seen = new Set();
  targets.forEach((t) => t.paths.forEach((m) => { if (!seen.has(m.contactIdx)) { seen.add(m.contactIdx); order.push(m.contactIdx); } }));
  const contacts = order.slice(0, 28);
  const cPos = new Map(), M = contacts.length || 1;
  contacts.forEach((ci, i) => {
    const a = (-90 + i * 360 / M) * Math.PI / 180;
    cPos.set(ci, { x: cx + Rct * Math.cos(a), y: cy + Rct * Math.sin(a) });
  });
  const N = targets.length;
  const coPos = targets.map((t, i) => {
    const a = (-90 + i * 360 / N) * Math.PI / 180;
    return { x: cx + Rco * Math.cos(a), y: cy + Rco * Math.sin(a), t };
  });

  let edges = "";
  contacts.forEach((ci) => { const p = cPos.get(ci); edges += `<line class="ne you" x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"/>`; });
  coPos.forEach((cp) => cp.t.paths.forEach((m) => {
    const p = cPos.get(m.contactIdx); if (!p) return;
    edges += `<line class="ne link ${PATH[m.type].cls}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${cp.x.toFixed(1)}" y2="${cp.y.toFixed(1)}"/>`;
  }));

  let nodes = "";
  coPos.forEach((cp) => {
    const c = cp.t.company;
    const anchor = cp.x < cx - 12 ? "end" : cp.x > cx + 12 ? "start" : "middle";
    const dx = anchor === "end" ? -12 : anchor === "start" ? 12 : 0;
    nodes += `<g class="nn co" data-memo="${escapeHtml(c.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(c.name)} memo">
      <circle cx="${cp.x.toFixed(1)}" cy="${cp.y.toFixed(1)}" r="7"/>
      <text x="${(cp.x + dx).toFixed(1)}" y="${(cp.y + 3.5).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(truncate(c.name, 18))}</text>
    </g>`;
  });
  contacts.forEach((ci) => { const p = cPos.get(ci); nodes += `<g class="nn ct"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5"><title>${escapeHtml((state.contacts[ci] || {}).name || "")}</title></circle></g>`; });
  nodes += `<g class="nn you"><circle cx="${cx}" cy="${cy}" r="12"/><text x="${cx}" y="${cy + 4}" text-anchor="middle">You</text></g>`;

  $("netGraph").innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="net-svg" role="img" aria-label="Relationship graph from you, through your contacts, to target companies">
    <g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`;
  $("netGraph").querySelectorAll(".nn.co").forEach((g) => {
    const open = () => openMemo(g.getAttribute("data-memo"));
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ===========================================================================
// NETWORK GRAPH UI (Build 2/3) — unified relationship graph
//   Renders startup paths (You → contact → company) alongside investor paths
//   (You → contact → investor firm → partner), with toggle filters and
//   per-node drawers. Reads Build 1/3 state (state.matches / investorIntroMatches
//   / investorUniverse / superConnectors / enrichedCompanies). Client-side only.
// ===========================================================================

const NETWORK_GRAPH_DEFAULT_FILTERS = {
  startup: true,
  investor: true,
  partner: true,
  companyInvestor: true,
  verifiedOnly: false,
  highAccessOnly: false,
};
const NETWORK_GRAPH_FILTER_PILLS = [
  { key: "startup", lbl: "Startup paths" },
  { key: "investor", lbl: "Investor paths" },
  { key: "partner", lbl: "Partner paths" },
  { key: "companyInvestor", lbl: "Company ↔ investor" },
  { key: "verifiedOnly", lbl: "Verified only" },
  { key: "highAccessOnly", lbl: "A / A+ paths" },
];
const NETWORK_GRAPH_LEGEND = [
  { cls: "you", lbl: "You" },
  { cls: "contact", lbl: "Your contact" },
  { cls: "company", lbl: "Target company" },
  { cls: "investor", lbl: "Investor firm" },
  { cls: "partner", lbl: "Partner" },
];
const NETWORK_NODE_R = { you: 13, contact: 5, company: 7.5, investor: 8.5, partner: 6.5 };

function getNetworkGraphFilters() {
  if (!state.networkGraphFilters) state.networkGraphFilters = { ...NETWORK_GRAPH_DEFAULT_FILTERS };
  return state.networkGraphFilters;
}
function setNetworkGraphFilter(key) {
  const f = getNetworkGraphFilters();
  if (!(key in f)) return;
  f[key] = !f[key];
  renderNetworkGraphFromState();
}

const slugId = (s) => safeText(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const graphNodeId = (type, key) => `${type}:${slugId(key)}`;
const truncateGraphLabel = (s, n) => truncate(s, n);
const contactSlug = (email, name) => slugId(email || name || "contact");
function scorePassesGraphFilter(score, filters) { return !filters.highAccessOnly || Number(score || 0) >= 75; }
function confidencePassesGraphFilter(verified, filters) { return !filters.verifiedOnly || !!verified; }

function buildNetworkGraphModel(st, filters) {
  const nodes = new Map();
  const edges = [];
  const addNode = (id, data) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign({ id }, data));
    else Object.assign(nodes.get(id), data, { id });
    return nodes.get(id);
  };
  const addEdge = (from, to, kind, meta) => edges.push(Object.assign({ from, to, kind }, meta || {}));

  addNode("you", { type: "you", label: "You" });

  // Startup paths: You -> contact -> company (uses the existing engine output).
  if (filters.startup) {
    netTargets().slice(0, 16).forEach((t) => {
      const co = t.company;
      const coId = graphNodeId("company", co.id);
      let used = false;
      t.paths.forEach((m) => {
        const verified = !!(PATH[m.type] && PATH[m.type].precise);
        if (!confidencePassesGraphFilter(verified, filters)) return;
        if (filters.highAccessOnly && !verified) return;
        const ct = m.contact || {};
        const ctId = graphNodeId("contact", ct.email || ct.name || ("idx-" + m.contactIdx));
        addNode(ctId, { type: "contact", label: ct.name || ct.email || "Contact", contact: ct });
        addEdge("you", ctId, "you-contact");
        addEdge(ctId, coId, "contact-company", { pathType: m.type, verified });
        used = true;
      });
      if (used) addNode(coId, { type: "company", label: co.name, companyId: co.id, company: co });
    });
  }

  // Investor paths: You -> contact -> investor firm -> partner.
  if (filters.investor) {
    (st.investorIntroMatches || []).forEach((m) => {
      if (!confidencePassesGraphFilter(m.verified, filters)) return;
      if (!scorePassesGraphFilter(m.investorAccessScore, filters)) return;
      const ctId = graphNodeId("contact", m.contactEmail || m.contactName || "contact");
      addNode(ctId, {
        type: "contact", label: m.contactName || m.contactEmail || "Contact",
        contact: { name: m.contactName, email: m.contactEmail, url: m.contactLinkedIn, title: m.contactTitle, company: m.contactCompany },
      });
      const invId = graphNodeId("investor", m.targetInvestor);
      addNode(invId, { type: "investor", label: m.targetInvestor, match: m });
      addEdge("you", ctId, "you-contact");
      addEdge(ctId, invId, "contact-investor", { verified: !!m.verified });
      if (filters.partner && m.targetPartner) {
        const pId = graphNodeId("partner", m.targetInvestor + " " + m.targetPartner);
        addNode(pId, { type: "partner", label: m.targetPartner, match: m, firm: m.targetInvestor });
        addEdge(invId, pId, "investor-partner", { verified: !!m.verified });
      }
    });
  }

  if (filters.companyInvestor) addCompanyInvestorEdges(nodes, edges, st);

  return { nodes: Array.from(nodes.values()), edges };
}

// Link company nodes to investor nodes where the company carries investor data
// (sparse for SEC radar companies — acceptable; never errors).
function addCompanyInvestorEdges(nodes, edges, st) {
  const invByName = new Map();
  nodes.forEach((n) => { if (n.type === "investor") invByName.set(normalizeName(n.label), n.id); });
  if (!invByName.size) return;
  const byId = new Map((st.enrichedCompanies || []).map((c) => [c.id, c]));
  nodes.forEach((n) => {
    if (n.type !== "company") return;
    const c = byId.get(n.companyId) || n.company || {};
    const firms = [...asArray(c.investors), ...asArray(c.knownInvestors), ...asArray(c.possibleInvestors), ...asArray(c.backers)]
      .map((x) => (typeof x === "string" ? x : safeText(x && (x.name || x.firm || x.investor)))).filter(Boolean);
    firms.forEach((fn) => { const id = invByName.get(normalizeName(fn)); if (id) edges.push({ from: n.id, to: id, kind: "company-investor" }); });
  });
}

function placeRing(arr, R, cx, cy, startDeg, pos, spanDeg) {
  const span = spanDeg == null ? 360 : spanDeg;
  const M = arr.length || 1;
  const step = span >= 360 ? span / M : (M > 1 ? span / (M - 1) : 0);
  arr.forEach((n, i) => {
    const a = (startDeg + i * step) * Math.PI / 180;
    pos.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });
}

function positionNetworkGraphNodes(model, W, H) {
  const cx = W / 2, cy = H / 2, pos = new Map();
  pos.set("you", { x: cx, y: cy });
  const contacts = model.nodes.filter((n) => n.type === "contact");
  const companies = model.nodes.filter((n) => n.type === "company");
  const investors = model.nodes.filter((n) => n.type === "investor");
  const partners = model.nodes.filter((n) => n.type === "partner");

  placeRing(contacts, 122, cx, cy, -90, pos);            // inner ring, full circle
  placeRing(companies, 238, cx, cy, 120, pos, 150);      // left arc — startup access
  placeRing(investors, 238, cx, cy, -75, pos, 150);      // right arc — investor access
  partners.forEach((p) => {
    const e = model.edges.find((ed) => ed.kind === "investor-partner" && ed.to === p.id);
    const inv = e && pos.get(e.from);
    if (inv) {
      const ang = Math.atan2(inv.y - cy, inv.x - cx);
      pos.set(p.id, { x: cx + 320 * Math.cos(ang), y: cy + 320 * Math.sin(ang) });
    } else pos.set(p.id, { x: cx + 320, y: cy });
  });
  return pos;
}

function renderNetworkSvgEdge(e, pos) {
  const a = pos.get(e.from), b = pos.get(e.to);
  if (!a || !b) return "";
  return `<line class="ngraph-edge e-${e.kind}${e.verified ? " is-verified" : ""}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
}

function renderNetworkSvgNode(n, pos, cx) {
  const p = pos.get(n.id);
  if (!p) return "";
  const r = NETWORK_NODE_R[n.type] || 6;
  const isCenter = n.type === "you";
  const anchor = isCenter ? "middle" : p.x < cx - 12 ? "end" : p.x > cx + 12 ? "start" : "middle";
  const dx = isCenter ? 0 : anchor === "end" ? -(r + 5) : anchor === "start" ? (r + 5) : 0;
  const dy = isCenter ? 4 : 3.4;
  const interactive = !isCenter;
  const label = isCenter ? "You" : truncateGraphLabel(n.label, 20);
  const kindLabel = { contact: "contact", company: "company", investor: "investor firm", partner: "partner" }[n.type] || "node";
  return `<g class="ngraph-node nn-${n.type}" data-node-id="${escapeHtml(n.id)}"${interactive ? ` tabindex="0" role="button" aria-label="Open ${escapeHtml(kindLabel)} ${escapeHtml(n.label)}"` : ""}>
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"></circle>
    <text x="${(p.x + dx).toFixed(1)}" y="${(p.y + dy).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(label)}</text>
  </g>`;
}

function renderNetworkRelationshipGraph(model) {
  const W = 960, H = 580, cx = W / 2;
  const pos = positionNetworkGraphNodes(model, W, H);
  const edges = model.edges.map((e) => renderNetworkSvgEdge(e, pos)).join("");
  const order = { contact: 0, company: 1, investor: 2, partner: 3, you: 4 };
  const nodes = model.nodes.slice().sort((a, b) => (order[a.type] || 0) - (order[b.type] || 0))
    .map((n) => renderNetworkSvgNode(n, pos, cx)).join("");
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="net-svg ngraph-svg" role="img" aria-label="Relationship graph: you, your contacts, target companies, investor firms and partners">
    <g class="edges">${edges}</g><g class="nodes">${nodes}</g></svg>`;
}

function renderNetworkGraphControls() {
  const host = document.querySelector("[data-network-graph-controls]");
  if (!host) return;
  const f = getNetworkGraphFilters();
  host.innerHTML = NETWORK_GRAPH_FILTER_PILLS.map((p) =>
    `<button type="button" class="ngraph-pill${f[p.key] ? " on" : ""}" data-graph-filter="${p.key}" aria-pressed="${f[p.key] ? "true" : "false"}">${escapeHtml(p.lbl)}</button>`).join("");
  host.querySelectorAll("[data-graph-filter]").forEach((b) =>
    b.addEventListener("click", () => setNetworkGraphFilter(b.getAttribute("data-graph-filter"))));
}

function renderNetworkGraphFromState() {
  const host = document.querySelector("[data-network-graph]") || $("netGraph");
  if (!host) return;
  renderNetworkGraphControls();
  const model = buildNetworkGraphModel(state, getNetworkGraphFilters());
  const legend = `<div class="network-legend">${NETWORK_GRAPH_LEGEND.map((l) => `<span class="nlg nlg-${l.cls}">${escapeHtml(l.lbl)}</span>`).join("")}</div>`;
  if (!model.nodes.some((n) => n.type !== "you")) {
    host.innerHTML = legend + `<div class="ngraph-empty">No paths match the current filters.</div>`;
    return;
  }
  host.innerHTML = legend + `<div class="ngraph-scroll">${renderNetworkRelationshipGraph(model)}</div>`;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  host.querySelectorAll(".ngraph-node[data-node-id]").forEach((g) => {
    const node = byId.get(g.getAttribute("data-node-id"));
    if (!node || node.type === "you") return;
    const open = () => openNetworkNodeDrawer(node);
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// --- node drawers (reuse the existing #drawer / #drawerOverlay + closeMemo) ---
function openNetworkNodeDrawer(node) {
  if (node.type === "company" && node.companyId && state.byId[node.companyId]) { openMemo(node.companyId); return; }
  $("drawer").innerHTML = `<button class="close" aria-label="Close">×</button>` + networkNodeDrawerHTML(node);
  $("drawer").hidden = false;
  $("drawerOverlay").hidden = false;
  $("drawer").scrollTop = 0;
  $("drawer").querySelector(".close").addEventListener("click", closeMemo);
}
function networkNodeDrawerHTML(node) {
  if (node.type === "investor") return investorNodeDrawerHTML(node);
  if (node.type === "partner") return partnerNodeDrawerHTML(node);
  if (node.type === "contact") return contactNodeDrawerHTML(node);
  if (node.type === "company") return companyNodeDrawerHTML(node);
  return `<h2>${escapeHtml(node.label || "")}</h2>`;
}
const pathChain = (arr) => arr.filter(Boolean).map((x) => `<span>${escapeHtml(x)}</span>`).join('<span class="nd-arrow">→</span>');

function investorNodeDrawerHTML(node) {
  const firmName = node.label;
  const all = (state.investorIntroMatches || []).filter((m) => m.targetInvestor === firmName);
  const best = all.slice().sort((a, b) => b.investorAccessScore - a.investorAccessScore)[0] || node.match || {};
  const firm = (state.investorUniverse || []).find((f) => normalizeName(f.name) === normalizeName(firmName)) || {};
  const site = firm.website ? (/^https?:/.test(firm.website) ? firm.website : "https://" + firm.website) : "";
  const signals = (best.matchSignals || []).map((s) => `<span class="np-tag">${escapeHtml(s.replace(/_/g, " "))}</span>`).join(" ");
  const partners = (firm.partners || []).map((p) => escapeHtml(p.name + (p.title ? " · " + p.title : ""))).join(", ");
  return `
    <div class="net-drawer">
      <span class="nd-kind nd-kind-investor">Investor firm</span>
      <h2>${escapeHtml(firmName)}</h2>
      ${site ? `<div class="memo-sub"><a href="${escapeHtml(site)}" target="_blank" rel="noopener">${escapeHtml(domainFromWebsite(firm.website) || firm.website)} ↗</a></div>` : ""}
      <div class="memo-grid">
        <div class="memo-kv"><div class="k">Access score</div><div class="v">${escapeHtml(best.investorAccessScore == null ? "—" : best.investorAccessScore)}</div></div>
        <div class="memo-kv"><div class="k">Confidence</div><div class="v">${escapeHtml(best.confidence || "—")}${best.verified ? " · verified" : ""}</div></div>
        <div class="memo-kv"><div class="k">Warm paths</div><div class="v">${all.length || 1}</div></div>
        <div class="memo-kv"><div class="k">Portfolio</div><div class="v">${(firm.portfolioCompanies || []).length || "—"}</div></div>
      </div>
      <div class="memo-sec"><h4>Best path</h4><div class="nd-path">${pathChain(best.relationshipPath || ["You", best.contactName, firmName])}</div></div>
      <div class="memo-sec"><h4>Evidence</h4><p>${escapeHtml(best.matchReason || "Contact appears connected to this firm.")}</p>${signals ? `<div class="tags">${signals}</div>` : ""}</div>
      ${partners ? `<div class="memo-sec"><h4>Partners</h4><p>${partners}</p></div>` : ""}
      <div class="memo-sec"><h4>Recommended ask</h4><p>${escapeHtml(best.recommendedAsk || "")}</p></div>
    </div>`;
}
function partnerNodeDrawerHTML(node) {
  const m = node.match || {};
  return `
    <div class="net-drawer">
      <span class="nd-kind nd-kind-partner">Partner</span>
      <h2>${escapeHtml(node.label)}</h2>
      <div class="memo-sub">${escapeHtml(m.targetPartnerTitle || "Partner")} · ${escapeHtml(m.targetInvestor || node.firm || "")}</div>
      <div class="memo-sec"><h4>Path</h4><div class="nd-path">${pathChain(m.relationshipPath || ["You", m.contactName, m.targetInvestor, node.label])}</div></div>
      <div class="memo-sec"><h4>Why it matters</h4><p>${escapeHtml(m.matchReason || "A warm path to a specific partner beats a cold firm intro.")}</p></div>
      <div class="memo-sec"><h4>Recommended ask</h4><p>${escapeHtml(m.recommendedAsk || "")}</p></div>
    </div>`;
}
function contactNodeDrawerHTML(node) {
  const ct = node.contact || {};
  const key = contactSlug(ct.email, ct.name || node.label);
  const items = [];
  (state.matches || []).filter((m) => contactSlug((m.contact || {}).email, (m.contact || {}).name) === key)
    .forEach((m) => items.push(`<li>${escapeHtml(m.company.name)} <span class="muted">· startup (${escapeHtml((PATH[m.type] || {}).label || m.type)})</span></li>`));
  const seen = new Set();
  (state.investorIntroMatches || []).filter((m) => contactSlug(m.contactEmail, m.contactName) === key)
    .forEach((m) => { if (seen.has(m.targetInvestor)) return; seen.add(m.targetInvestor); items.push(`<li>${escapeHtml(m.targetInvestor)} <span class="muted">· investor${m.targetPartner ? " (" + escapeHtml(m.targetPartner) + ")" : ""}</span></li>`); });
  const links = [];
  if (ct.url) links.push(`<a href="${escapeHtml(ct.url)}" target="_blank" rel="noopener">profile ↗</a>`);
  if (ct.email) links.push(`<a href="mailto:${escapeHtml(ct.email)}">email ↗</a>`);
  return `
    <div class="net-drawer">
      <span class="nd-kind nd-kind-contact">Your contact</span>
      <h2>${escapeHtml(node.label)}</h2>
      <div class="memo-sub">${escapeHtml([ct.title, ct.company].filter(Boolean).join(" · ") || "—")}</div>
      ${links.length ? `<div class="drawer-cta">${links.join("")}</div>` : ""}
      <div class="memo-sec"><h4>Connects you to</h4><ul>${items.join("") || "<li>—</li>"}</ul></div>
    </div>`;
}
function companyNodeDrawerHTML(node) {
  const c = node.company || {};
  return `<div class="net-drawer"><span class="nd-kind nd-kind-company">Target company</span><h2>${escapeHtml(node.label)}</h2><div class="memo-sub">${escapeHtml(c.jurisdiction || "—")}</div></div>`;
}

// ===========================================================================
// NETWORK ACTION LAYER (Build 3/3) — investor warm-intro cards, super-connector
//   cards, copyable outreach drafts, localStorage-backed saved target lists,
//   and an evidence audit (signal/source chips). Reads Build 1/3+2/3 state
//   (state.investorIntroMatches / state.superConnectors / state.matches).
//   Client-side only; saved targets persist in localStorage.
// ===========================================================================

const NETWORK_TARGETS_STORAGE_KEY = "scout_network_targets_v1";
const networkInvestorCards = new Map();   // card id -> investor intro match
const networkConnectorCards = new Map();  // card id -> super-connector

const SIGNAL_LABELS = {
  employer_exact_match: "Employer match (exact)",
  employer_fuzzy_match: "Employer match (fuzzy)",
  email_domain_match: "Email domain match",
  partner_name_match: "Partner name match",
  partner_linkedin_exact_match: "Partner LinkedIn match",
  partner_linkedin_match: "Partner LinkedIn match",
  title_vc_keyword: "VC-style title",
  linkedin_firm_match: "LinkedIn → firm",
};
const STRONG_SIGNALS = new Set(["employer_exact_match", "email_domain_match", "partner_linkedin_exact_match", "partner_linkedin_match"]);

function readableSignal(sig) {
  const key = safeText(sig);
  if (SIGNAL_LABELS[key]) return SIGNAL_LABELS[key];
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function readableConnectorType(type) {
  return {
    bridge_super_connector: "Bridge connector · startup + investor",
    founder_side_super_connector: "Founder-side connector",
    investor_side_super_connector: "Investor-side connector",
    single_path_connector: "Single-path connector",
  }[type] || "Connector";
}
function accessGradeFromScore(score) {
  const s = Number(score || 0);
  if (s >= 90) return { grade: "A+", cls: "grade-aplus" };
  if (s >= 75) return { grade: "A", cls: "grade-a" };
  if (s >= 60) return { grade: "B", cls: "grade-b" };
  if (s >= 40) return { grade: "C", cls: "grade-c" };
  return { grade: "D", cls: "grade-d" };
}
function inferThesisFitFromMatch(m) {
  const firm = (state.investorUniverse || []).find((f) => normalizeName(f.name) === normalizeName(m.targetInvestor));
  const tags = asArray(firm && firm.thesisTags).map(safeText).filter(Boolean).slice(0, 3);
  return tags.length ? `It looks aligned with their focus on ${tags.join(", ")}.` : "";
}

function renderPathPills(path) {
  const parts = asArray(path).map(safeText).filter(Boolean);
  if (!parts.length) return "";
  return `<div class="path-pill-row">${parts.map((p, i) =>
    `<span class="path-pill">${escapeHtml(p)}</span>${i < parts.length - 1 ? `<span class="path-arrow">→</span>` : ""}`).join("")}</div>`;
}
function renderEvidenceChips(signals, sourceFields) {
  const sigChips = asArray(signals).map((s) =>
    `<span class="evidence-chip${STRONG_SIGNALS.has(safeText(s)) ? " is-verified" : ""}">${escapeHtml(readableSignal(s))}</span>`);
  const srcChips = asArray(sourceFields).map((f) =>
    `<span class="evidence-chip is-source">${escapeHtml(safeText(f))}</span>`);
  const all = sigChips.concat(srcChips);
  return all.length ? all.join("") : `<span class="evidence-chip">No structured signals</span>`;
}

// --- outreach drafts -------------------------------------------------------
function buildFallbackInvestorAsk(m) {
  return `Ask ${m.contactName || "your contact"} to confirm their connection to ${m.targetInvestor} before requesting a specific intro.`;
}
function buildInvestorDraft(m, type) {
  const firm = m.targetInvestor;
  const partner = m.targetPartner ? `${m.targetPartner}${m.targetPartnerTitle ? `, ${m.targetPartnerTitle}` : ""}` : "";
  const contact = m.contactName || "there";
  const fit = inferThesisFitFromMatch(m);
  const path = asArray(m.relationshipPath).map(safeText).filter(Boolean).join(" → ");
  if (type === "direct") {
    return `Hi ${contact} — I saw you're connected to ${firm}${partner ? ` (${partner})` : ""}. `
      + `I'm working on an early-stage AI opportunity that may fit their thesis.${fit ? " " + fit : ""} `
      + `Any chance you could make a warm intro, or point me to the best person there?`;
  }
  if (type === "crm") {
    return [
      `[Investor access] ${firm}${partner ? ` · ${partner}` : ""}`,
      `Connector: ${m.contactName || "—"}${m.contactTitle ? `, ${m.contactTitle}` : ""}${m.contactCompany ? ` @ ${m.contactCompany}` : ""}`,
      `Path: ${path || "You → contact → firm"}`,
      `Confidence: ${m.confidence || "—"} · Access score: ${m.investorAccessScore == null ? "—" : m.investorAccessScore}${m.verified ? " · verified" : " · inferred"}`,
      `Evidence: ${m.matchReason || "—"} [${asArray(m.matchSignals).join(", ") || "no signals"}]`,
      `Next step: ${m.recommendedAsk || buildFallbackInvestorAsk(m)}`,
    ].join("\n");
  }
  // intro (forwardable request)
  return [
    `Subject: Quick intro to ${firm}?`,
    ``,
    `Hi ${contact},`,
    ``,
    `Hope you're well. I'm looking at ${firm}${partner ? ` — ideally ${partner}` : ""} for an early-stage AI opportunity I'm working on.${fit ? " " + fit : ""}`,
    ``,
    `Would you be open to a quick intro, or pointing me to the right person there? Happy to send a short forwardable blurb.`,
    ``,
    `Thanks!`,
  ].join("\n");
}
function buildFallbackSuperConnectorAction(sc) {
  return `Ask ${sc.contactName} which of their connections is the best fit before requesting a specific intro.`;
}
function buildSuperConnectorDraft(sc, type) {
  const name = sc.contactName || "there";
  const startups = asArray(sc.startupTargets).slice(0, 3).join(", ");
  const investors = asArray(sc.investorTargets).slice(0, 3).join(", ");
  const top = [startups, investors].filter(Boolean).join(" and ") || "a few things I'm tracking";
  if (type === "specific") {
    return `Hi ${name} — you're connected to ${top}. I'm working on an early-stage AI opportunity and would value a warm intro to whichever of these is the best fit. Could you point me to the right one?`;
  }
  if (type === "crm") {
    return [
      `[Super-connector] ${sc.contactName} · ${readableConnectorType(sc.connectorType)}`,
      `Startups: ${asArray(sc.startupTargets).join(", ") || "—"}`,
      `Investors: ${asArray(sc.investorTargets).join(", ") || "—"}`,
      `Partners: ${asArray(sc.partnerTargets).join(", ") || "—"}`,
      `Leverage score: ${sc.leverageScore}`,
      `Next step: ${sc.recommendedAction || buildFallbackSuperConnectorAction(sc)}`,
    ].join("\n");
  }
  // category-level ask
  return `Hi ${name} — you seem connected across a few things I'm tracking (${top}). `
    + `Before I ask for anything specific, would you be open to a quick category-level read on where the most interesting early-stage AI activity is right now?`;
}
function buildStartupDraft(t) {
  const c = t.company, best = (t.paths || [])[0] || {}, ct = best.contact || {};
  const cat = c.ai_category ? ` in ${c.ai_category}` : "";
  return `Hi ${ct.name || "there"} — I noticed your connection to ${c.name}. I'm looking at early-stage AI companies${cat} and would love a quick intro to the founding team, or a pointer to who's best to reach. Open to it?`;
}

// --- clipboard -------------------------------------------------------------
function fallbackCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
  } catch (_) {}
}
function copyButtonFeedback(btn, label) {
  if (!btn) return;
  if (btn.__fbTimer) { clearTimeout(btn.__fbTimer); btn.textContent = btn.__fbOld; }
  btn.__fbOld = btn.textContent;
  btn.textContent = label || "Copied ✓";
  btn.classList.add("is-success");
  btn.__fbTimer = setTimeout(() => { btn.textContent = btn.__fbOld; btn.classList.remove("is-success"); btn.__fbTimer = null; }, 1500);
}
function copyTextWithFeedback(text, btn, label) {
  const done = () => copyButtonFeedback(btn, label);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopyText(text); done(); });
  } else { fallbackCopyText(text); done(); }
}

// --- saved targets (localStorage) ------------------------------------------
function getNetworkTargets() {
  try {
    const o = JSON.parse(localStorage.getItem(NETWORK_TARGETS_STORAGE_KEY) || "null");
    return { companies: asArray(o && o.companies), investors: asArray(o && o.investors) };
  } catch (_) { return { companies: [], investors: [] }; }
}
function setNetworkTargets(targets) {
  try {
    localStorage.setItem(NETWORK_TARGETS_STORAGE_KEY, JSON.stringify({
      companies: asArray(targets.companies), investors: asArray(targets.investors),
    }));
  } catch (_) {}
}
function saveNetworkTarget(kind, target) {
  if (!target || !target.id) return;
  const t = getNetworkTargets();
  const list = kind === "investor" ? t.investors : t.companies;
  if (!list.some((x) => x.id === target.id)) list.push(target);
  setNetworkTargets(t);
  renderNetworkTargets();
}
function removeNetworkTarget(kind, id) {
  const t = getNetworkTargets();
  if (kind === "investor") t.investors = t.investors.filter((x) => x.id !== id);
  else t.companies = t.companies.filter((x) => x.id !== id);
  setNetworkTargets(t);
  renderNetworkTargets();
}
function investorTargetFromMatch(m) {
  return { id: slugId(m.targetInvestor), kind: "investor", name: m.targetInvestor, partner: m.targetPartner || "", score: Number(m.investorAccessScore || 0) };
}
function companyTargetFromStartupMatch(t) {
  const c = t.company || {};
  return { id: c.id, kind: "company", name: c.name, score: oppOf(c), jurisdiction: c.jurisdiction || "" };
}
function companyTargetHTML(x) {
  const meta = [x.score ? `opp ${x.score}` : "", x.jurisdiction].filter(Boolean).join(" · ");
  return `<div class="target-item"><div class="target-body"><b>${escapeHtml(x.name)}</b>${meta ? `<div class="target-meta">${escapeHtml(meta)}</div>` : ""}</div>
    <button class="ghost-button small" type="button" data-remove-target="${escapeHtml(x.id)}" data-target-kind="company">Remove</button></div>`;
}
function investorTargetHTML(x) {
  const meta = [x.partner ? `partner ${x.partner}` : "", x.score ? `access ${x.score}` : ""].filter(Boolean).join(" · ");
  return `<div class="target-item"><div class="target-body"><b>${escapeHtml(x.name)}</b>${meta ? `<div class="target-meta">${escapeHtml(meta)}</div>` : ""}</div>
    <button class="ghost-button small" type="button" data-remove-target="${escapeHtml(x.id)}" data-target-kind="investor">Remove</button></div>`;
}
function renderNetworkTargets() {
  const coHost = document.querySelector("[data-company-target-list]");
  const invHost = document.querySelector("[data-investor-target-list]");
  if (!coHost && !invHost) return;
  const t = getNetworkTargets();
  if (coHost) coHost.innerHTML = t.companies.length ? t.companies.map(companyTargetHTML).join("") : `<div class="target-empty">No saved companies yet.</div>`;
  if (invHost) invHost.innerHTML = t.investors.length ? t.investors.map(investorTargetHTML).join("") : `<div class="target-empty">No saved investors yet.</div>`;
  document.querySelectorAll("[data-remove-target]").forEach((b) =>
    b.addEventListener("click", () => removeNetworkTarget(b.getAttribute("data-target-kind"), b.getAttribute("data-remove-target"))));
  const clearBtn = document.querySelector("[data-clear-network-targets]");
  if (clearBtn && !clearBtn.__bound) {
    clearBtn.__bound = true;
    clearBtn.addEventListener("click", () => { setNetworkTargets({ companies: [], investors: [] }); renderNetworkTargets(); });
  }
}

// --- cards -----------------------------------------------------------------
function investorIntroCardHTML(m, id) {
  const grade = accessGradeFromScore(m.investorAccessScore);
  const partnerLine = m.targetPartner
    ? `<div class="intro-card-partner">Partner · <b>${escapeHtml(m.targetPartner)}</b>${m.targetPartnerTitle ? ` · ${escapeHtml(m.targetPartnerTitle)}` : ""}</div>` : "";
  const connector = [m.contactName, m.contactTitle, m.contactCompany].map(safeText).filter(Boolean).join(" · ") || "—";
  const ask = m.recommendedAsk || buildFallbackInvestorAsk(m);
  return `
    <article class="network-intro-card investor-intro-card" data-card-id="${escapeHtml(id)}">
      <div class="intro-card-topline">
        <div class="intro-card-id">
          <span class="eyebrow">Investor access</span>
          <h4>${escapeHtml(m.targetInvestor)}</h4>
          ${partnerLine}
        </div>
        <div class="intro-score ${m.verified ? "score-verified" : "score-inferred"}">
          <span class="access-grade ${grade.cls}">${grade.grade}</span>
          <span class="score-num">${escapeHtml(m.investorAccessScore == null ? "—" : m.investorAccessScore)}</span>
          <span class="score-lbl">access</span>
        </div>
      </div>
      <div class="intro-card-grid">
        <div><div class="mini-label">Best connector</div><div>${escapeHtml(connector)}</div></div>
        <div><div class="mini-label">Confidence</div><div>${escapeHtml(m.confidence || "—")} ${m.verified ? `<span class="np-tag precise">verified</span>` : `<span class="np-tag infer">inferred</span>`}</div></div>
      </div>
      <div class="relationship-path"><div class="mini-label">Relationship path</div>${renderPathPills(m.relationshipPath && m.relationshipPath.length ? m.relationshipPath : ["You", m.contactName, m.targetInvestor, m.targetPartner])}</div>
      <div class="evidence-box">
        <div class="evidence-header">Evidence audit</div>
        <p>${escapeHtml(m.matchReason || "Contact appears connected to this firm.")}</p>
        <div class="evidence-chip-row">${renderEvidenceChips(m.matchSignals, m.sourceFields)}</div>
      </div>
      <div class="recommended-ask"><div class="mini-label">Recommended ask</div><p>${escapeHtml(ask)}</p></div>
      <div class="intro-actions">
        <button class="primary-button small" type="button" data-copy-investor-draft data-draft-type="intro" data-card-id="${escapeHtml(id)}">Copy intro draft</button>
        <button class="ghost-button small" type="button" data-copy-investor-draft data-draft-type="direct" data-card-id="${escapeHtml(id)}">Copy direct note</button>
        <button class="ghost-button small" type="button" data-copy-investor-draft data-draft-type="crm" data-card-id="${escapeHtml(id)}">Copy CRM note</button>
        <button class="ghost-button small" type="button" data-save-investor-target data-card-id="${escapeHtml(id)}">Save target</button>
      </div>
    </article>`;
}
function superConnectorCardHTML(sc, id) {
  const targetList = (label, arr) => {
    const items = asArray(arr);
    if (!items.length) return "";
    return `<div class="connector-target-group"><div class="mini-label">${escapeHtml(label)}</div><div>${items.slice(0, 6).map((x) => `<span class="path-pill">${escapeHtml(x)}</span>`).join(" ")}</div></div>`;
  };
  return `
    <article class="network-intro-card super-connector-card" data-connector-id="${escapeHtml(id)}">
      <div class="intro-card-topline">
        <div class="intro-card-id">
          <span class="eyebrow">Super-connector</span>
          <h4>${escapeHtml(sc.contactName || "Contact")}</h4>
          <div class="connector-type">${escapeHtml(readableConnectorType(sc.connectorType))}</div>
        </div>
        <div class="intro-score score-verified">
          <span class="score-num">${escapeHtml(sc.leverageScore)}</span>
          <span class="score-lbl">leverage</span>
        </div>
      </div>
      <div class="connector-stats">
        <div class="connector-stat"><b>${asArray(sc.startupTargets).length}</b><span>startups</span></div>
        <div class="connector-stat"><b>${asArray(sc.investorTargets).length}</b><span>investors</span></div>
        <div class="connector-stat"><b>${asArray(sc.partnerTargets).length}</b><span>partners</span></div>
      </div>
      <div class="connector-targets">
        ${targetList("Startups", sc.startupTargets)}
        ${targetList("Investors", sc.investorTargets)}
        ${targetList("Partners", sc.partnerTargets)}
      </div>
      <div class="recommended-ask"><div class="mini-label">Recommended action</div><p>${escapeHtml(sc.recommendedAction || buildFallbackSuperConnectorAction(sc))}</p></div>
      <div class="intro-actions">
        <button class="primary-button small" type="button" data-copy-connector-draft data-draft-type="category" data-connector-id="${escapeHtml(id)}">Copy category ask</button>
        <button class="ghost-button small" type="button" data-copy-connector-draft data-draft-type="specific" data-connector-id="${escapeHtml(id)}">Copy specific ask</button>
        <button class="ghost-button small" type="button" data-copy-connector-draft data-draft-type="crm" data-connector-id="${escapeHtml(id)}">Copy CRM note</button>
      </div>
    </article>`;
}

function renderInvestorIntroCards() {
  const host = document.querySelector("[data-investor-intro-cards]");
  if (!host) return;
  networkInvestorCards.clear();
  const matches = (state.investorIntroMatches || []).slice().sort((a, b) => (b.investorAccessScore || 0) - (a.investorAccessScore || 0));
  if (!matches.length) {
    host.innerHTML = `<div class="network-empty-card">No investor paths yet. Load the sample, or import contacts whose company or LinkedIn matches a firm in the deals export.</div>`;
    return;
  }
  host.innerHTML = matches.map((m, i) => {
    const id = slugId(`${m.targetInvestor}-${m.contactName}-${m.targetPartner || ""}-${i}`);
    networkInvestorCards.set(id, m);
    return investorIntroCardHTML(m, id);
  }).join("");
}
function renderSuperConnectorCards() {
  const host = document.querySelector("[data-super-connector-cards]");
  if (!host) return;
  networkConnectorCards.clear();
  const list = state.superConnectors || [];
  if (!list.length) {
    host.innerHTML = `<div class="network-empty-card">No super-connectors yet. These surface when one contact bridges multiple startups and/or investors — try a fuller contact export.</div>`;
    return;
  }
  host.innerHTML = list.map((sc, i) => {
    const id = slugId(`${sc.contactName}-${i}`);
    networkConnectorCards.set(id, sc);
    return superConnectorCardHTML(sc, id);
  }).join("");
}
function bindNetworkActionEvents() {
  document.querySelectorAll("[data-copy-investor-draft]").forEach((b) => b.addEventListener("click", () => {
    const m = networkInvestorCards.get(b.getAttribute("data-card-id")); if (!m) return;
    copyTextWithFeedback(buildInvestorDraft(m, b.getAttribute("data-draft-type")), b);
  }));
  document.querySelectorAll("[data-save-investor-target]").forEach((b) => b.addEventListener("click", () => {
    const m = networkInvestorCards.get(b.getAttribute("data-card-id")); if (!m) return;
    saveNetworkTarget("investor", investorTargetFromMatch(m)); copyButtonFeedback(b, "Saved ✓");
  }));
  document.querySelectorAll("[data-copy-connector-draft]").forEach((b) => b.addEventListener("click", () => {
    const sc = networkConnectorCards.get(b.getAttribute("data-connector-id")); if (!sc) return;
    copyTextWithFeedback(buildSuperConnectorDraft(sc, b.getAttribute("data-draft-type")), b);
  }));
}
function renderNetworkActionLayerFromState() {
  renderInvestorIntroCards();
  renderSuperConnectorCards();
  bindNetworkActionEvents();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
document.addEventListener("click", (e) => { if (e.target.id === "drawerOverlay") closeMemo(); });

load();
