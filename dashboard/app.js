"use strict";
// NEXDRAIN dashboard. Polls /api/state once a second and draws only the section on screen.

const STALE_S = 30;
const NAMES = { H2S: "Hydrogen sulphide", CH4: "Methane", CO: "Carbon monoxide", NH3: "Ammonia", O2: "Oxygen", Level: "Sewage level" };
const LIMITS = { H2S: "10 ppm", CH4: "5,000 ppm", CO: "35 ppm", NH3: "25 ppm", O2: "below 19.5%" };
const GASES = ["H2S", "CH4", "CO", "NH3", "O2"];
const COLS = { live: { CH4: 1, CO: 2, Level: 3, Rssi: 4 }, sim: { H2S: 1, CH4: 2, CO: 3, NH3: 4, Level: 5 } };  // history columns
const CVAR = { H2S: "--c-h2s", CH4: "--c-ch4", CO: "--c-co", NH3: "--c-nh3", Level: "--c-lvl" };
const RANK = { Safe: 0, "Early Warning": 1, Imminent: 2, Critical: 3 };
const VIEWS = ["overview", "work", "analytics", "alerts", "device", "about"];
const ROLES = { supervisor: ["overview", "work", "analytics", "alerts", "about"], technician: VIEWS, worker: ["entry"] };
const WHO = { supervisor: "Supervisor", technician: "Technician", worker: "Crew", system: "NEXDRAIN" };
const KIND = { evacuate: ["Evacuate", "s-Critical"], limit: ["Time limit", "s-Imminent"], stop: ["Stop work", "s-EarlyWarning"], break: ["Break", "s-EarlyWarning"],
  resume: ["Resume work", "s-Safe"], clear: ["All clear", "s-Safe"], text: ["Message", "s-Stale"], sos: ["Help needed", "s-Critical"], missed: ["Missed check-in", "s-Imminent"] };
const PRESETS = [["evacuate", "Evacuate now. Leave the tank immediately."], ["stop", "Stop work and wait at the opening."], ["break", "Come out for a break."],
  ["resume", "Air is normal. You may carry on."], ["clear", "All clear. Work is finished, close the lid."]];
const FLOOR_Y = 604, FULL_Y = 262, WINDOW_S = 600;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = id => document.getElementById(id);
const cls = s => "s-" + String(s).replace(/\s/g, "");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pctTxt = v => (v ?? 0) >= 200 ? "200%+" : Math.round(v ?? 0) + "%";
const ppm = v => v == null ? "" : v >= 100 ? Math.round(v).toLocaleString("en-IN") : v.toFixed(1);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dur = s => s < 60 ? Math.round(s) + " s" : s < 3600 ? (s / 60).toFixed(1) + " min" : `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`;
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };

const params = new URLSearchParams(location.search);   // ?role=worker&mode=sim opens a screen directly, e.g. on a phone
let mode = params.get("mode") || (location.hash === "#sim" || pref("nx-mode") === "sim" ? "sim" : "live");
if (mode !== "sim") mode = "live";
let role = ROLES[params.get("role")] ? params.get("role") : ROLES[pref("nx-role")] ? pref("nx-role") : "supervisor";
let view = "overview";
let last = null, lastLines = -1, lastSimT = -1, lastWord = "", hidden = new Set(), hover = null, seenEvents = null;
let msgSeen = null, keys = {};   // keys: last-drawn content of lists that are rebuilt only when they change

const clock = t => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const mmss = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

async function post(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, error: j.error };
  } catch { return { ok: false, error: "The receiver is not responding" }; }
}
async function op(action, extra) {   // one work-cycle action; the server checks the rules and says no in plain words
  const r = await post("/api/ops", { mode, role, action, ...extra });
  if (!r.ok) pop("s-Critical", "Not done", r.error || "Something went wrong");
  tick();
  return r.ok;
}

// ---------- intro: once per browser tab; ?intro plays it again ----------
(function intro() {
  const el = $("intro");
  let seen = false;
  try { seen = sessionStorage.getItem("nx-intro") === "1"; } catch (e) {}
  if (seen && !location.search.includes("intro")) { el.remove(); return; }
  try { sessionStorage.setItem("nx-intro", "1"); } catch (e) {}
  if (!reduce) el.classList.add("play");
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    el.classList.add("out");
    setTimeout(() => el.remove(), reduce ? 0 : 700);
  };
  setTimeout(end, reduce ? 900 : 3300);
  el.addEventListener("click", end);
  addEventListener("keydown", end, { once: true });
})();

// ---------- theme ----------
$("theme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  pref("nx-theme", t);
  if (last) render(last);
};

// ---------- routing: section, data source, role ----------
function setView(v) {
  const allowed = ROLES[role];
  view = allowed.includes(v) ? v : allowed[0];
  document.querySelectorAll(".view").forEach(s => s.classList.toggle("on", s.id === "v-" + view));
  document.querySelectorAll("#nav a").forEach(a => {
    a.hidden = !allowed.includes(a.dataset.v);
    a.toggleAttribute("aria-current", a.dataset.v === view);
    if (a.dataset.v === view) a.setAttribute("aria-current", "page");
  });
  $("nav").hidden = role === "worker";
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  lastWord = ""; alertsKey = ""; keys = {};
  if (last) render(last);
}
addEventListener("hashchange", () => setView(location.hash.slice(1)));

function setMode(m) {
  mode = m;
  pref("nx-mode", m);
  document.body.className = m;
  $("tab-live").setAttribute("aria-selected", m === "live");
  $("tab-sim").setAttribute("aria-selected", m === "sim");
  $("seg").dataset.m = m;
  tileKeys = ""; alertsKey = ""; seenEvents = null; lastWord = ""; msgSeen = null; keys = {};
  if (last) render(last);
}
$("tab-live").onclick = () => setMode("live");
$("tab-sim").onclick = () => setMode("sim");
$("role").value = role;
$("role").onchange = e => { role = e.target.value; pref("nx-role", role); setView(view); };

$("sim-start").onclick = () => post("/api/sim/start", { scenario: $("scenario").value, gas: $("gas").value, speed: Number($("speed").value) });
$("sim-stop").onclick = () => post("/api/sim/stop");
$("ack").onclick = $("ack-hero").onclick = () => post("/api/ack", { mode });
$("csv").onclick = downloadCsv;
$("sound").checked = pref("nx-sound") !== "0";
$("sound").onchange = e => pref("nx-sound", e.target.checked ? "1" : "0");

addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k >= "1" && k <= "6") setView(VIEWS[Number(k) - 1]);
  else if (k === "l") setMode("live");
  else if (k === "s") setMode("sim");
  else if (k === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
});

// ---------- the data source on screen, in one shape ----------
function source(d) {
  if (mode === "sim") {
    const s = d.sim;
    return { st: s.state || null, hist: s.history || [], events: s.events || [], stale: !s.state, now: s.t ?? 0, s };
  }
  const L = d.live;
  return { st: L.state, hist: L.history || [], events: L.events || [], stale: L.age_s == null || L.age_s > STALE_S, now: d.now, L };
}
const statusOf = S => S.stale ? "Stale" : S.st.site_status;
const openAlerts = S => S.events.filter(e => !e.acked);
const evTime = t => mode === "sim" ? `minute ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`
  : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function headline(st) {
  const gases = Object.entries(st.gases).filter(([, g]) => g.installed);
  const more = st.multi_gas ? " Several gases are rising together." : "";
  for (const s of ["Critical", "Imminent", "Early Warning"]) {
    const hit = gases.find(([, g]) => g.status === s);
    if (hit) {
      const [k, g] = hit;
      return { key: k, eta: g.eta,
        why: (s === "Critical" ? `${NAMES[k]} has reached its danger level of ${LIMITS[k]}.`
          : `${NAMES[k]} is rising. It is at ${pctTxt(g.pct)} of its danger level of ${LIMITS[k]}.`) + more };
    }
    if (st.level && st.level.status === s) {
      const f = Math.round(st.level.fill_pct ?? 0);
      return { key: "Level", eta: st.level.eta, why: s === "Critical" ? `The tank is ${f}% full and about to overflow.` : `Sewage is high: the tank is ${f}% full.` };
    }
  }
  return { key: null, eta: null, why: "Every fitted sensor is below its danger level and steady." };
}

function staleWhy(S) {
  if (mode === "sim") return "Choose a scenario above and press Start.";
  if (!S.st) return "Waiting for the sensor box. Check its power, the USB cable or the radio.";
  return `No reading for ${Math.round(S.L.age_s)} seconds. Check the box power and link. The box still sounds its own alarm.`;
}

// ---------- overview ----------
function renderOverview(d, S) {
  const status = statusOf(S);
  $("hero").className = "hero glass " + cls(status);
  $("status").className = "status " + cls(status);
  const word = status === "Stale" ? (mode === "sim" ? "Ready" : "No data") : status;
  if (word !== lastWord && !reduce) $("word").animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 500, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  lastWord = word;
  $("word").textContent = word;
  const h = S.st && !S.stale ? headline(S.st) : null;
  $("why").textContent = h ? h.why : staleWhy(S);
  $("eta-box").hidden = !h?.eta;
  $("eta").textContent = h?.eta || "";

  // connection line in the corner
  if (mode === "sim") {
    const s = S.s;
    $("link").className = "link " + (s.running ? "s-Safe" : "s-Stale");
    $("link-t").innerHTML = s.state ? `<b>${s.running ? "Running" : "Finished"}</b>, minute ${Math.floor(s.t / 60)} of ${s.duration / 60}` : "Simulation ready";
  } else {
    const L = S.L, b = S.st?.box;
    const via = b?.source === "lora" ? `LoRa${b.rssi != null ? ", " + b.rssi + " dBm" : ""}` : b?.source === "usb" ? "USB cable" : b?.source || "";
    $("link").className = "link " + (L.age_s == null ? "s-Stale" : S.stale ? "s-Critical" : "s-Safe");
    $("link-t").innerHTML = L.age_s == null ? "Waiting for the box" : S.stale ? `<b>No data for ${Math.round(L.age_s)} s</b>` : `<b>Live</b> by ${esc(via)}`;
  }

  // one line per fitted sensor
  if (!S.st) $("mini").innerHTML = "";
  else {
    const fitted = GASES.filter(k => S.st.gases[k]?.installed), off = GASES.filter(k => !S.st.gases[k]?.installed);
    const rows = fitted.map(k => [k, S.st.gases[k].status, pctTxt(S.st.gases[k].pct) + " of danger", S.st.gases[k].pct]);
    if (S.st.level) rows.push(["Level", S.st.level.status, Math.round(S.st.level.fill_pct ?? 0) + "% full", S.st.level.fill_pct]);
    $("mini").innerHTML = rows.map(([k, st, txt, v]) => `<div class="mini-row ${cls(S.stale ? "Stale" : st)}"><span>${NAMES[k]}</span><b>${txt}</b>
      <span class="bar"><i style="width:${Math.min(v ?? 0, 100)}%"></i></span></div>`).join("")
      + (off.length ? `<div class="mini-off">Not fitted on the prototype: ${off.map(k => NAMES[k].toLowerCase()).join(", ")}</div>` : "");
  }
  $("acts").hidden = !(openAlerts(S).length + openUp(d.ops[mode]).length) || role === "worker";
  scene(status, S.st, !S.stale && (mode === "live" || S.s.running), mode === "sim" ? S.s.t !== lastSimT : S.L.lines !== lastLines);
}

// ---------- worker entry check ----------
function renderEntry(d, S, O) {
  const maint = O.mode === "maintenance", status = maint ? "Stale" : statusOf(S);
  $("entry-card").className = "entry glass " + cls(status);
  const h = S.st && !S.stale ? headline(S.st) : null;
  const [word, why] = maint ? ["Box under maintenance", "Do not rely on this screen. Test the air with a portable gas detector."]
    : status === "Stale" ? ["No data", mode === "sim" ? "Start a simulated leak to see the worker screen." : "Do not rely on this screen. Check the sensor box."]
    : status === "Safe" ? ["No gas warning", O.mode === "cleaning" ? "Readings are normal. Keep checking in." : "Readings are normal. Still follow the entry procedure."]
    : status === "Critical" ? ["Do not enter", h.why]
    : ["Do not open the lid", h.why];
  $("entry-word").textContent = word;
  $("entry-why").textContent = why;
  $("entry-eta").hidden = !h?.eta || status === "Critical";
  $("entry-eta").textContent = h?.eta ? "Danger in " + h.eta : "";
  $("checklist").hidden = status !== "Safe" || O.mode !== "normal";
  renderCrew(d, status, O);
}

// ---------- worker: crew actions at the tank ----------
function renderCrew(d, status, O) {
  const clean = O.mode === "cleaning";
  $("crew-clean").hidden = !clean;
  $("crew-mode").textContent = clean ? `Permit open: ${O.permit.task}. Attendant ${O.permit.attendant}. Time limit ${O.permit.max_min} min inside.`
    : O.mode === "maintenance" ? "The box is being serviced. Use a portable gas detector."
    : "No permit is open. Nobody goes in until the supervisor opens one.";
  if (!clean) return;
  const due = O.last_checkin + O.permit.checkin_min * 60 - d.now;
  $("ci-due").textContent = due >= 0 ? `Next check-in in ${mmss(due)}` : `Check-in late by ${mmss(-due)}`;
  $("checkin").classList.toggle("late", due < 0);
  $("in-form").querySelector("button").disabled = status !== "Safe";
  people("inside", O, d.now, true);
}

function people(id, O, now, canExit) {   // who is inside, with time against the permit's limit
  const names = Object.keys(O.inside), lim = O.permit.max_min * 60;
  const k = names.join("|") + canExit;
  if (keys[id] !== k) {
    keys[id] = k;
    $(id).innerHTML = names.length ? names.map(n => `<div class="person" data-in="${O.inside[n]}"><b>${esc(n)}</b><span class="tin"></span>
      <span class="bar"><i></i></span>${canExit ? `<button class="btn" type="button" data-act="exit" data-name="${esc(n)}">Came out</button>` : ""}</div>`).join("")
      : `<p class="sub">Nobody is inside.</p>`;
  }
  $(id).querySelectorAll(".person").forEach(p => {
    const s = now - Number(p.dataset.in), over = s > lim;
    p.classList.toggle("over", over);
    p.querySelector(".tin").textContent = `${mmss(s)} of ${O.permit.max_min}:00${over ? ", over the limit" : ""}`;
    p.querySelector(".bar i").style.width = Math.min(100, 100 * s / lim) + "%";
  });
}

$("checkin").onclick = () => op("checkin");
$("sos").onclick = () => { if (confirm("Send a help request to the supervisor now?")) op("sos"); };
$("in-form").onsubmit = async e => {
  e.preventDefault();
  if (await op("enter", { name: $("in-name").value })) $("in-name").value = "";
};
document.addEventListener("click", e => {   // buttons inside lists that are redrawn
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act;
  if (a === "exit") op("exit", { name: b.dataset.name });
  else if (a === "resolve") op("resolve", { id: Number(b.dataset.id) });
  else if (a === "check") op("check", { what: b.dataset.what });
  else if (a === "msg") sendMsg(b.dataset.kind, b.dataset.text);
});

// ---------- takeover: a message from the supervisor fills the worker's screen ----------
let shownMsg = null;
const dismissed = new Set();   // view-only copies close the takeover locally; they cannot mark it seen
function renderTakeover(O) {
  const m = role === "worker" ? O.msgs.find(x => !x.up && x.done == null && !dismissed.has(x.id)) : null;
  $("takeover").hidden = !m;
  if (!m) { shownMsg = null; return; }
  const [ttl, c] = KIND[m.kind];
  $("takeover").className = "takeover " + c;
  $("to-from").textContent = `${ttl}, from ${m.from === "system" ? "NEXDRAIN" : "the " + WHO[m.from].toLowerCase()} at ${clock(m.t)}${mode === "sim" ? ". SIMULATED" : ""}`;
  $("to-text").textContent = m.text;
  if (shownMsg !== m.id) { shownMsg = m.id; $("to-ok").focus(); }
  $("to-ok").onclick = () => last?.view_only ? (dismissed.add(m.id), renderTakeover(O)) : op("seen", { id: m.id });
}

// ---------- work: permit, maintenance, messages ----------
const openUp = O => O.msgs.filter(m => m.up && m.done == null);
const checksTicked = () => [...$("pf-checks").querySelectorAll("input:checked")].map(i => i.value);

$("presets").innerHTML = PRESETS.map(([k, t]) => `<button class="btn${k === "evacuate" ? " alarm s-Critical" : ""}" type="button" data-act="msg" data-kind="${k}" data-text="${esc(t)}">${KIND[k][0]}</button>`).join("");
function sendMsg(kind, text) {
  if (kind === "evacuate" && !confirm("Order everyone out of the tank now?")) return;
  op("message", { kind, text });
}
$("msg-form").onsubmit = e => { e.preventDefault(); const t = $("msg-t").value.trim(); if (t) { op("message", { kind: "text", text: t }); $("msg-t").value = ""; } };
$("pf-checks").onchange = () => last && renderWork(last, source(last), last.ops[mode]);
$("permit-form").onsubmit = e => {
  e.preventDefault();
  op("start_cleaning", { task: $("pf-task").value, attendant: $("pf-att").value, max_min: Number($("pf-max").value), checkin_min: Number($("pf-ci").value), checks: checksTicked() })
    .then(ok => ok && $("pf-checks").querySelectorAll("input").forEach(i => { i.checked = false; }));
};
$("maint-form").onsubmit = e => { e.preventDefault(); op("start_maint", { reason: $("mf-reason").value, minutes: Number($("mf-min").value) }); };
$("pc-end").onclick = () => {
  const inside = Object.keys(last?.ops[mode].inside || {});
  if (inside.length && !confirm(`${inside.join(", ")} still logged inside. Close the permit anyway?`)) return;
  op("end_cleaning", { force: inside.length > 0 });
};
$("mc-end").onclick = () => op("end_maint");
$("ho-form").onsubmit = async e => { e.preventDefault(); if (await op("handover", { text: $("ho-t").value })) $("ho-t").value = ""; };
$("print").onclick = () => {
  $("print-h").textContent = `NEXDRAIN shift report, Tank 1. Printed ${new Date().toLocaleString()}.${mode === "sim" ? " SIMULATED DATA." : ""}`;
  print();
};

const kv = rows => rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
function renderWork(d, S, O) {
  $("modes").querySelectorAll("span").forEach(s => s.classList.toggle("on", s.dataset.m === O.mode));
  const sup = role === "supervisor", tech = role === "technician", normal = O.mode === "normal";
  $("permit-form").hidden = !(normal && sup);
  $("maint-form").hidden = !(normal && tech);
  $("idle-card").hidden = !(normal && !sup && !tech);
  $("permit-card").hidden = O.mode !== "cleaning";
  $("maint-card").hidden = O.mode !== "maintenance";
  const status = statusOf(S);

  if (normal && sup) {
    const ticked = checksTicked().length === 6;
    $("pf-go").disabled = status !== "Safe" || !ticked;
    $("pf-why").textContent = status === "Stale" ? "Waiting for current readings from the box." : status !== "Safe" ? `Tank status is ${status}. Nobody goes in.`
      : ticked ? "Readings are Safe. Ready to start." : `Tick every check to continue (${checksTicked().length} of 6).`;
  }
  if (O.mode === "cleaning") {
    const p = O.permit, due = O.last_checkin + p.checkin_min * 60 - d.now;
    $("pc-air").className = "pill " + cls(status);
    $("pc-air").innerHTML = `<span class="shape" aria-hidden="true"></span>Air: ${status === "Stale" ? "no data" : status}`;
    $("pc-kv").innerHTML = kv([["Task", p.task], ["Opened by", `${WHO[p.by]} at ${clock(p.start)}`], ["Open for", mmss(d.now - p.start)],
      ["Attendant", p.attendant], ["Time limit inside", p.max_min + " min"],
      ["Next crew check-in", !Object.keys(O.inside).length ? "starts when someone goes in" : due >= 0 ? "in " + mmss(due) : "late by " + mmss(-due)]]);
    people("pc-people", O, d.now, sup);
    $("pc-end").hidden = !sup;
  }
  if (O.mode === "maintenance") {
    $("mc-kv").innerHTML = kv([["Work", O.maint.reason], ["Started by", `${WHO[O.maint.by]} at ${clock(O.since)}`], ["Alarms back on in", mmss(O.maint.until - d.now)]]);
  }
  $("idle-t").textContent = "The supervisor opens a cleaning permit from this page. The technician starts maintenance from here too.";

  // talk to the crew: supervisor sends, technician reads
  $("presets").hidden = $("msg-form").hidden = !sup;
  $("talk-sub").textContent = sup ? `Your message fills the worker's screen until they tap "Got it". You see when it was seen.` : "Messages between the supervisor and the crew. Only the supervisor sends.";
  const reqs = openUp(O), rk = reqs.map(m => m.id).join();
  if (keys.req !== rk + sup) {
    keys.req = rk + sup;
    $("requests").innerHTML = reqs.map(m => `<div class="req ${KIND[m.kind][1]}"><span class="shape" aria-hidden="true"></span>
      <div><b>${KIND[m.kind][0]}</b><span>${esc(m.text)}, ${clock(m.t)}</span></div>
      ${sup ? `<button class="btn alarm" type="button" data-act="resolve" data-id="${m.id}">Responding</button>` : ""}</div>`).join("");
  }
  const ms = O.msgs.slice(-12).reverse(), mk = ms.map(m => m.id + ":" + m.done).join();
  if (keys.msgs !== mk) {
    keys.msgs = mk;
    $("msgs").innerHTML = ms.length ? ms.map(m => `<li class="${KIND[m.kind][1]}"><span class="shape" aria-hidden="true"></span>
      <div><b>${m.up ? "From the crew" : "To the crew"}: ${esc(m.text)}</b>
      <span>${WHO[m.from]} at ${clock(m.t)}. ${m.done == null ? (m.up ? "Waiting for a response" : "Not seen yet") : (m.up ? "Responded at " : "Seen at ") + clock(m.done)}</span></div></li>`).join("")
      : `<li class="s-Stale none">No messages yet.</li>`;
  }
}

// ---------- the mode banner on every screen ----------
function renderModebar(d, O) {
  const on = O.mode !== "normal";
  $("modebar").hidden = !on;
  if (!on) return;
  $("modebar").className = "modebar glass m-" + O.mode;
  const n = Object.keys(O.inside).length;
  $("mb-tag").textContent = O.mode === "cleaning" ? "CLEANING" : "MAINTENANCE";
  $("mb-t").textContent = O.mode === "cleaning"
    ? `${O.permit.task}. ${n ? n + (n > 1 ? " people" : " person") + " inside" : "Nobody inside yet"}. Permit open for ${mmss(d.now - O.permit.start)}.`
    : `${O.maint.reason}. Alarm sounds paused for ${mmss(O.maint.until - d.now)} more. Readings are still logged.`;
  $("mb-go").hidden = role === "worker" || view === "work";
}

// ---------- activity log ----------
function renderLog(O) {
  const lg = O.log.slice().reverse(), k = lg.length + ":" + (lg[0]?.t ?? "");
  if (keys.log === k) return;
  keys.log = k;
  $("log").innerHTML = lg.length ? lg.map(e => `<li><time>${clock(e.t)}</time><span class="who">${WHO[e.who] || esc(e.who)}</span><span>${esc(e.what)}</span></li>`).join("")
    : `<li class="none">Nothing yet. Permits, messages, check-ins and maintenance appear here.</li>`;
}

// ---------- analytics ----------
let tileKeys = "";
function buildTiles(keys) {
  $("tiles").innerHTML = keys.map((k, i) => `<article class="tile glass" id="tile-${k}" style="--i:${i}">
    <div class="t-head"><span class="t-name">${NAMES[k]}</span><span class="chip"><span class="shape" aria-hidden="true"></span><span class="chip-t"></span></span></div>
    <div class="t-val"><span class="num" data-v="0">0</span>%<small>${k === "Level" ? "full" : "of " + LIMITS[k]}</small></div>
    <svg class="spark" viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="sg-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0.32"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <path class="ar" fill="url(#sg-${k})"/><line class="lim" x1="0" x2="300" y1="8" y2="8"/><path class="ln"/></svg>
    <div class="t-foot"></div>
    <div class="t-stats"><span>Peak <b class="pk">0%</b></span><span>Above half <b class="ab">0 s</b></span></div></article>`).join("");
  tileKeys = keys.join();
}

function glide(el, to) {
  const from = Number(el.dataset.v) || 0;
  el.dataset.v = to;
  const fmt = v => v >= 200 ? "200+" : Math.round(v);
  if (reduce || Math.abs(to - from) < 0.5) { el.textContent = fmt(to); return; }
  let t0 = null;
  const step = now => {
    t0 ??= now;   // start on the first frame's clock, so progress never goes negative
    const k = Math.min(Math.max((now - t0) / 600, 0), 1), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1 && Number(el.dataset.v) === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function sparkPaths(hist, col, lo = 0, hi = 120) {
  const pts = hist.slice(-300).map(r => [r[0], r[col]]).filter(p => p[1] != null);
  if (pts.length < 2) return ["", ""];
  const W = 300, H = 48, t0 = pts[0][0], span = Math.max(pts[pts.length - 1][0] - t0, 1);
  const y = v => (H - H * (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)).toFixed(1);
  const d = pts.map(([t, v], i) => (i ? "L" : "M") + ((t - t0) / span * W).toFixed(1) + " " + y(v)).join(" ");
  return [d, `${d} L ${W} ${H} L 0 ${H} Z`];
}

function windowRows(hist) {
  const tEnd = hist.length ? hist[hist.length - 1][0] : 0;
  return hist.filter(r => tEnd - r[0] <= WINDOW_S);
}
function seriesStats(rows, col) {   // peak, and seconds spent at or above half the danger level
  let peak = null, above = 0;
  rows.forEach((r, i) => {
    const v = r[col];
    if (v == null) return;
    peak = Math.max(peak ?? v, v);
    if (v >= 50 && i) above += r[0] - rows[i - 1][0];
  });
  return { peak, above };
}
function timeInWarning(events, now) {
  let total = 0;
  events.forEach((e, i) => {
    const end = i + 1 < events.length ? events[i + 1].t : now;
    if (e.status !== "Safe") total += Math.max(end - e.t, 0);
  });
  return total;
}

function renderAnalytics(d, S) {
  $("an-sub").textContent = mode === "sim" ? "Simulated readings from this run, as a share of each danger level." : "Every reading from the last 10 minutes, as a share of each danger level. ppm figures are estimates: the sensors are not calibrated.";
  const cols = COLS[mode], rows = windowRows(S.hist);

  // headline numbers
  let worst = null;
  if (S.st) for (const k of GASES) { const g = S.st.gases[k]; if (g?.installed && (worst == null || g.pct > S.st.gases[worst].pct)) worst = k; }
  let peakK = null, peakV = null;
  for (const k of Object.keys(cols)) {
    if (k === "Level" || k === "Rssi") continue;
    const p = seriesStats(rows, cols[k]).peak;
    if (p != null && (peakV == null || p > peakV)) { peakK = k; peakV = p; }
  }
  const status = statusOf(S);
  const readings = mode === "sim" ? [S.hist.length, "simulated, one per second"]
    : [S.L.lines, `${S.L.lost} lost, ${S.L.lines + S.L.lost ? Math.round(100 * S.L.lines / (S.L.lines + S.L.lost)) : 100}% delivered`];
  const kpis = [
    ["Worst reading now", worst && !S.stale ? pctTxt(S.st.gases[worst].pct) : "--", worst && !S.stale ? NAMES[worst].toLowerCase() : "", status === "Stale" ? "No current data" : status],
    ["Peak, last 10 minutes", peakV != null ? pctTxt(peakV) : "--", peakK ? NAMES[peakK].toLowerCase() : "", "of its danger level"],
    ["Time in warning", dur(timeInWarning(S.events, mode === "sim" ? S.now : d.now)), "", `${S.events.filter(e => e.status !== "Safe").length} warnings raised`],
    ["Readings", readings[0].toLocaleString("en-IN"), "", readings[1]],
  ];
  $("kpis").innerHTML = kpis.map(([k, v, sm, dd], i) => `<div class="kpi glass${i ? "" : " lead " + cls(status)}"><span class="k">${k}</span>
    <span class="v">${esc(v)}<small>${esc(sm)}</small></span><span class="d">${esc(dd)}</span></div>`).join("");

  // sensor tiles
  if (!S.st) { $("tiles").innerHTML = ""; tileKeys = ""; $("offline").textContent = mode === "sim" ? "Start a simulation to see readings." : "No readings yet."; }
  else {
    const fitted = GASES.filter(k => S.st.gases[k]?.installed), off = GASES.filter(k => !S.st.gases[k]?.installed);
    const keys = S.st.level ? [...fitted, "Level"] : fitted;
    if (keys.join() !== tileKeys) buildTiles(keys);
    const learning = S.st.learning || {};
    for (const k of keys) {
      const el = $("tile-" + k), isLvl = k === "Level", g = isLvl ? S.st.level : S.st.gases[k];
      el.className = "tile glass " + cls(S.stale ? "Stale" : g.status);
      el.querySelector(".chip-t").textContent = g.status;
      glide(el.querySelector(".num"), isLvl ? (g.fill_pct ?? 0) : (g.pct ?? 0));
      const [ln, ar] = sparkPaths(S.hist, cols[k]);
      el.querySelector(".ln").setAttribute("d", ln);
      el.querySelector(".ar").setAttribute("d", ar);
      const st = seriesStats(rows, cols[k]);
      el.querySelector(".pk").textContent = st.peak == null ? "--" : pctTxt(st.peak);
      el.querySelector(".ab").textContent = dur(st.above);
      const foot = el.querySelector(".t-foot");
      let txt = isLvl ? (g.dist_cm != null ? `${Math.round(g.dist_cm)} cm below the sensor` : "No echo") : `About ${ppm(g.ppm_est)} ppm, estimated`, hot = false;
      if (g.eta) { txt = (isLvl ? "Overflow in " : "Danger in ") + g.eta; hot = true; }
      else if (learning[k] != null) txt = `Learning clean air, ${learning[k]} of 30`;
      else if (g.phase === "H") txt = "Heater cleaning cycle, reading held";
      else if (g.phase === "C") txt += ", indicative only";
      foot.textContent = txt;
      foot.className = "t-foot" + (hot ? " hot" : "");
    }
    $("offline").innerHTML = off.length ? `<b>Not fitted on the prototype:</b> ${off.map(k => NAMES[k].toLowerCase()).join(", ")}. Planned for the pilot box.` : "";
  }
  renderStrip(S);
  drawChart(S);
}

function renderStrip(S) {   // tank status across the chart's 10 minutes, from the alert log
  const tEnd = S.hist.length ? S.hist[S.hist.length - 1][0] : S.now, t0 = tEnd - WINDOW_S;
  const segs = [];
  let cur = "Stale", from = t0;
  for (const e of S.events) {
    if (e.t <= t0) { cur = e.status; continue; }
    if (e.t > tEnd) break;
    segs.push([cur, e.t - from]); cur = e.status; from = e.t;
  }
  segs.push([cur, tEnd - from]);
  $("strip").innerHTML = segs.filter(([, w]) => w > 0).map(([s, w]) => `<i class="${cls(s)}" style="width:${(100 * w / WINDOW_S).toFixed(2)}%" title="${esc(s)}"></i>`).join("");
}

function seriesFor() { return mode === "sim" ? ["H2S", "CH4", "CO", "NH3", "Level"] : ["CH4", "CO", "Level"]; }
function buildLegend() {
  const s = seriesFor();
  if ($("legend").dataset.k === s.join()) return;
  $("legend").dataset.k = s.join();
  $("legend").innerHTML = s.map(k => `<button type="button" data-k="${k}" aria-pressed="${!hidden.has(k)}">
    <i class="${k === "Level" ? "dash" : ""}" style="--c: var(${CVAR[k]})"></i>${NAMES[k]}</button>`).join("");
  $("legend").querySelectorAll("button").forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    b.setAttribute("aria-pressed", !hidden.has(k));
    if (last) drawChart(source(last));
  });
}

function drawChart(S) {
  buildLegend();
  const hist = S.hist, series = seriesFor(), cols = COLS[mode];
  const c = $("chart"), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = css("--ink"), muted = css("--muted"), line = css("--line"), crit = css("--critical");
  const pad = { l: 46, r: 16, t: 14, b: 28 }, top = 125;
  const Y = v => pad.t + (h - pad.t - pad.b) * (1 - Math.min(v, top) / top);
  const tEnd = hist.length ? hist[hist.length - 1][0] : 0;
  const X = t => pad.l + (w - pad.l - pad.r) * (1 - (tEnd - t) / WINDOW_S);
  x.font = "500 12px Geist, system-ui, sans-serif";
  x.fillStyle = crit; x.globalAlpha = 0.07; x.fillRect(pad.l, Y(top), w - pad.l - pad.r, Y(100) - Y(top)); x.globalAlpha = 1;
  x.strokeStyle = line; x.lineWidth = 1; x.fillStyle = muted;
  for (const v of [0, 25, 50, 75]) { x.beginPath(); x.moveTo(pad.l, Y(v)); x.lineTo(w - pad.r, Y(v)); x.stroke(); x.fillText(v + "%", 8, Y(v) + 4); }
  x.strokeStyle = crit; x.setLineDash([6, 5]); x.lineWidth = 1.5;
  x.beginPath(); x.moveTo(pad.l, Y(100)); x.lineTo(w - pad.r, Y(100)); x.stroke(); x.setLineDash([]);
  x.fillStyle = crit; x.fillText("100%", 8, Y(100) + 4); x.fillText("Danger level", pad.l + 8, Y(100) - 7);
  x.fillStyle = muted;
  for (let m = 0; m <= 10; m += 2) {
    x.textAlign = m === 0 ? "right" : "center";
    x.fillText(m === 0 ? "now" : `${m} min ago`, Math.min(X(tEnd - m * 60), w - pad.r), h - 8);
  }
  x.textAlign = "left";
  if (hist.length < 2) { x.font = "500 14px Geist, system-ui, sans-serif"; x.fillText("No readings yet", pad.l + 16, Y(55)); return; }
  const shown = windowRows(hist);
  for (const k of series) {
    if (hidden.has(k)) continue;
    const pts = shown.map(r => [X(r[0]), r[cols[k]]]).filter(p => p[1] != null).map(([px, v]) => [px, Y(v)]);
    if (pts.length < 2) continue;
    const col = css(CVAR[k]);
    const grad = x.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, col + "33"); grad.addColorStop(1, col + "00");
    x.beginPath(); pts.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py));
    x.lineTo(pts[pts.length - 1][0], Y(0)); x.lineTo(pts[0][0], Y(0)); x.closePath();
    x.fillStyle = grad; x.fill();
    x.beginPath(); pts.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py));
    x.strokeStyle = col; x.lineWidth = 2.5; x.lineJoin = "round";
    x.setLineDash(k === "Level" ? [7, 5] : []); x.stroke(); x.setLineDash([]);
    const [ex, ey] = pts[pts.length - 1];
    x.beginPath(); x.arc(ex, ey, 4, 0, Math.PI * 2); x.fillStyle = col; x.fill();
  }
  if (hover != null) {   // crosshair and readout at the pointer
    const tAt = tEnd - (1 - (hover - pad.l) / (w - pad.l - pad.r)) * WINDOW_S;
    let row = shown[0];
    for (const r of shown) if (Math.abs(r[0] - tAt) < Math.abs(row[0] - tAt)) row = r;
    const px = X(row[0]);
    x.strokeStyle = muted; x.lineWidth = 1; x.beginPath(); x.moveTo(px, pad.t); x.lineTo(px, h - pad.b); x.stroke();
    const items = series.filter(k => !hidden.has(k) && row[cols[k]] != null);
    const bw = 200, bh = 26 + items.length * 20, bx = px + 14 + bw > w ? px - 14 - bw : px + 14, by = pad.t + 6;
    x.fillStyle = css("--bg"); x.globalAlpha = 0.94; x.fillRect(bx, by, bw, bh); x.globalAlpha = 1;
    x.strokeStyle = line; x.strokeRect(bx, by, bw, bh);
    x.fillStyle = muted; x.fillText(`${Math.round((tEnd - row[0]) / 6) / 10} min ago`, bx + 10, by + 18);
    items.forEach((k, i) => {
      x.fillStyle = css(CVAR[k]); x.fillRect(bx + 10, by + 30 + i * 20, 10, 3);
      x.fillStyle = ink; x.fillText(`${NAMES[k]}: ${Math.round(row[cols[k]])}%`, bx + 28, by + 35 + i * 20);
    });
  }
}
$("chart").addEventListener("mousemove", e => { hover = e.offsetX; if (last) drawChart(source(last)); });
$("chart").addEventListener("mouseleave", () => { hover = null; if (last) drawChart(source(last)); });
addEventListener("resize", () => last && view === "analytics" && drawChart(source(last)));

function downloadCsv() {
  if (!last) return;
  const S = source(last), cols = COLS[mode], keys = Object.keys(cols);
  const head = ["time", ...keys.map(k => k === "Level" ? "level_fill_pct" : k === "Rssi" ? "signal_dbm" : k.toLowerCase() + "_pct_of_danger")];
  const rows = S.hist.map(r => [mode === "sim" ? r[0] : new Date(r[0] * 1000).toISOString(), ...keys.map(k => r[cols[k]] ?? "")]);
  const note = mode === "sim" ? "# SIMULATED DATA\n" : "# NEXDRAIN live readings. Percent of each danger level; sensors not calibrated.\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([note + [head, ...rows].map(r => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = `nexdrain-${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- alerts, sound, toasts ----------
function alertText(e) {
  if (e.prev == null) return [`Monitoring started`, `Tank status ${e.status}.`];
  const what = e.cause ? NAMES[e.cause] : "Tank";
  const pct = e.pct == null ? "" : e.cause === "Level" ? `, ${Math.round(e.pct)}% full` : `, ${pctTxt(e.pct)} of danger level`;
  return e.status === "Safe" ? [`Back to Safe`, `Everything below its warning level again, after ${e.prev}.`]
    : [`${what}: ${e.status}`, `Raised from ${e.prev}${pct}.${e.suppressed ? " During maintenance, no alarm sounded." : ""}`];
}

let alertsKey = "";
function renderAlerts(S) {
  const list = S.events.slice().reverse();
  $("ack").disabled = !openAlerts(S).length;
  const key = mode + list.length + ":" + openAlerts(S).length;
  if (key === alertsKey) return;   // rebuild only when the log changes, so rows do not re-animate every second
  alertsKey = key;
  if (!list.length) {
    $("alert-list").innerHTML = `<div class="empty"><b>No alerts yet</b>${mode === "sim" ? "Start a simulated leak and every change in tank status appears here." : "Every change in tank status appears here once the box is sending."}</div>`;
    return;
  }
  $("alert-list").innerHTML = list.map(e => {
    const [ttl, wh] = alertText(e);
    return `<div class="alert ${cls(e.status)}${e.acked ? "" : " open"}"><span class="ic"><span class="shape" aria-hidden="true"></span></span>
      <div><div class="ttl">${esc(ttl)}</div><div class="wh">${esc(wh)}</div></div>
      <div class="tm"><b>${evTime(e.t)}</b></div></div>`;
  }).join("");
}

let actx = null;
const unlockAudio = () => { try { actx ??= new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {} };
addEventListener("pointerdown", unlockAudio);
addEventListener("keydown", unlockAudio);
function beep(sev) {
  if (!actx || actx.state !== "running") return;
  const n = RANK[sev] || 1, t0 = actx.currentTime;
  for (let i = 0; i < n; i++) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = sev === "Critical" ? 988 : 784;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.16);
    o.connect(g).connect(actx.destination);
    o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.18);
  }
}
setInterval(() => {   // beep until someone acknowledges
  if (!last || !$("sound").checked) return;
  const O = last.ops[mode];
  if (role === "worker") {   // the crew's phone sounds for an order to get out until they tap "Got it"
    const m = O.msgs.find(x => !x.up && x.done == null);
    if (m && (m.kind === "evacuate" || m.kind === "limit")) beep("Critical");
    return;
  }
  if (openUp(O).length) return beep("Critical");   // help request or missed check-in
  if (O.mode === "maintenance") return;              // alarm sounds paused while the box is serviced
  const open = openAlerts(source(last));
  if (open.length) beep(open.reduce((a, e) => RANK[e.status] > RANK[a] ? e.status : a, "Early Warning"));
}, 3000);

function pop(c, ttl, wh) {
  const t = document.createElement("div");
  t.className = "toast glass " + c;
  t.innerHTML = `<span class="shape" aria-hidden="true"></span><b>${esc(ttl)}</b><span>${esc(wh)}${mode === "sim" ? " Simulated." : ""}</span>`;
  $("toasts").prepend(t);
  setTimeout(() => { t.classList.add("bye"); setTimeout(() => t.remove(), 300); }, 5000);
}
function checkNewEvents(S, O) {
  const n = S.events.length;
  if (seenEvents != null && n > seenEvents && O.mode !== "maintenance" && role !== "worker")
    S.events.slice(seenEvents).forEach(e => { if (e.prev != null && !e.suppressed && RANK[e.status] > (RANK[e.prev] ?? 0)) pop(cls(e.status), ...alertText(e)); });
  seenEvents = n;
  const open = openAlerts(S).length, up = openUp(O).length;
  $("badge").hidden = !open;
  $("badge").textContent = open;
  $("badge-w").hidden = !up;
  $("badge-w").textContent = up;
  // new help requests, and messages the crew has now seen
  const now = new Map(O.msgs.map(m => [m.id, m.done]));
  if (msgSeen && role !== "worker") for (const m of O.msgs) {
    if (!msgSeen.has(m.id) && m.up) pop(KIND[m.kind][1], KIND[m.kind][0], m.text);
    else if (!m.up && m.done != null && msgSeen.has(m.id) && msgSeen.get(m.id) == null) pop("s-Safe", "Seen by the crew", m.text);
  }
  msgSeen = now;
}

// ---------- device ----------
let devBuilt = false;
function buildDevice() {
  $("dev").innerHTML = `<div class="empty glass sim-only" style="border-radius: 28px"><b>Device health shows the real box</b>Switch to Live to see the radio, the sensors and the receiver.</div>
  <div class="devgrid live-only">
    <article class="dev glass span-4"><h3>Connection</h3>
      <div class="links"><div>LoRa radio <span class="pill" id="d-lora"></span></div><div>USB cable <span class="pill" id="d-usb"></span></div></div>
      <dl class="kv"><dt>Readings arrive by</dt><dd id="d-src">--</dd><dt>Last reading</dt><dd id="d-age">--</dd></dl></article>
    <article class="dev glass span-4"><h3>Radio signal</h3>
      <div class="big" id="d-rssi">--</div><span class="pill" id="d-rq"></span>
      <svg class="spark" viewBox="0 0 300 48" preserveAspectRatio="none" aria-hidden="true" style="color: var(--c-rssi)"><path class="ln" id="d-rssi-ln"/></svg>
      <span class="sub" id="d-snr">Signal to noise: --</span></article>
    <article class="dev glass span-4"><h3>Delivery</h3>
      <div class="big" id="d-deliv">--</div>
      <dl class="kv"><dt>Readings received</dt><dd id="d-lines">0</dd><dt>Readings lost</dt><dd id="d-lost">0</dd></dl></article>
    <article class="dev glass span-5"><h3>Sensor box</h3>
      <dl class="kv"><dt>Box</dt><dd id="d-box">--</dd><dt>Switched on for</dt><dd id="d-up">--</dd><dt>Box alarm</dt><dd id="d-alarm">--</dd><dt>Buzzer</dt><dd id="d-muted">--</dd></dl>
      <div class="btns"><button class="btn" id="d-mute" type="button">Mute buzzer</button><button class="btn" id="d-test" type="button">Test lights and buzzer</button></div>
      <span class="sub">Commands reach the box over the USB cable only.</span></article>
    <article class="dev glass span-7"><h3>Gas sensors</h3>
      <div class="heater"><svg class="ring s-Stale" id="d-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="tr" cx="50" cy="50" r="42"/><circle class="pr" id="d-ring-p" cx="50" cy="50" r="42" stroke-dasharray="264" stroke-dashoffset="264"/></svg>
        <div><b id="d-phase">Carbon monoxide heater</b><div class="sub" id="d-phase-s">Waiting for the box</div></div></div>
      <div class="learn" id="d-learn"></div>
      <div class="btns"><button class="btn" id="d-relearn" type="button">Relearn clean air</button></div></article>
    <article class="dev glass span-4"><h3>Safety checks</h3>
      <dl class="kv"><dt>Gas test with a known source</dt><dd id="d-bump">--</dd><dt>Lights and buzzer test</dt><dd id="d-alt">--</dd></dl>
      <span class="sub">Gas detector makers advise testing the alarm with a known gas before relying on it. Record each pass here; it is due again after a day.</span>
      <div class="btns"><button class="btn" type="button" data-act="check" data-what="bump">Record gas test</button><button class="btn" type="button" data-act="check" data-what="alarm">Record lights test</button></div></article>
    <article class="dev glass span-4"><h3>Level sensor</h3>
      <div class="big" id="d-dist">--</div>
      <dl class="kv"><dt>Reading when the tank is empty</dt><dd id="d-empty">--</dd><dt>Reading when the tank is full</dt><dd id="d-full">--</dd></dl>
      <span class="sub">Set both at the demo table: <span class="code">run.sh --empty-cm 60 --full-cm 25</span></span></article>
    <article class="dev glass span-4"><h3>Radio settings</h3>
      <dl class="kv"><dt>Frequency</dt><dd>433.5 MHz</dd><dt>Spreading factor</dt><dd>9</dd><dt>Bandwidth</dt><dd>125 kHz</dd><dt>Coding rate</dt><dd>4/5</dd><dt>Sync word</dt><dd>0x12</dd><dt>Transmit power</dt><dd>10 dBm, the legal limit in India</dd></dl></article>
  </div>`;
  $("d-mute").onclick = () => post("/api/box", { cmd: last?.live?.state?.box?.muted ? "U" : "M" });
  $("d-test").onclick = () => post("/api/box", { cmd: "T" });
  $("d-relearn").onclick = () => { if (confirm("Relearn clean air? Only do this with the sensors in clean air.")) post("/api/relearn"); };
  devBuilt = true;
}
const pill = (id, ok, txt, warn) => { $(id).className = "pill " + (ok ? "s-Safe" : warn ? "s-EarlyWarning" : "s-Stale"); $(id).innerHTML = `<span class="shape" aria-hidden="true"></span>${txt}`; };

function renderDevice(d, S) {
  if (!devBuilt) buildDevice();
  if (mode === "sim") return;
  const L = S.L, b = S.st?.box;
  pill("d-lora", d.links.lora, d.links.lora ? "Listening" : "Not found");
  pill("d-usb", d.links.usb, d.links.usb ? "Connected" : "Not connected");
  $("d-src").textContent = b ? (b.source === "lora" ? "LoRa radio" : b.source === "usb" ? "USB cable" : b.source) : "--";
  $("d-age").textContent = L.age_s == null ? "never" : dur(L.age_s) + " ago";
  const rssi = b?.rssi;
  $("d-rssi").innerHTML = rssi == null ? "--" : `${rssi}<small>dBm</small>`;
  pill("d-rq", rssi != null && rssi >= -120, rssi == null ? "No radio packets yet" : rssi >= -100 ? "Strong" : rssi >= -120 ? "Fine" : "Weak", rssi != null);
  $("d-snr").textContent = `Signal to noise: ${b?.snr != null ? b.snr.toFixed(1) + " dB" : "--"}`;
  $("d-rssi-ln").setAttribute("d", sparkPaths(S.hist, COLS.live.Rssi, -130, -30)[0]);
  const total = L.lines + L.lost;
  $("d-deliv").innerHTML = total ? `${Math.round(100 * L.lines / total)}<small>% delivered</small>` : "--";
  $("d-lines").textContent = L.lines.toLocaleString("en-IN");
  $("d-lost").textContent = L.lost.toLocaleString("en-IN");
  $("d-box").textContent = b ? `Box ${b.id}` : "--";
  $("d-up").textContent = b ? dur(b.uptime_s) : "--";
  $("d-alarm").textContent = b ? (b.alarm ? "Sounding" : "Quiet") : "--";
  $("d-muted").textContent = b ? (b.muted ? "Muted" : "On") : "--";
  $("d-mute").textContent = b?.muted ? "Unmute buzzer" : "Mute buzzer";
  for (const id of ["d-mute", "d-test"]) { $(id).disabled = !d.links.usb; $(id).title = d.links.usb ? "" : "Works when the box is connected by USB cable"; }

  const co = S.st?.gases?.CO;
  if (co?.phase === "C") {   // heater wired always on (no MOSFET): no cycle to show
    $("d-ring").setAttribute("class", "ring s-EarlyWarning");
    $("d-ring-p").setAttribute("stroke-dashoffset", "0");
    $("d-phase").textContent = "CO heater: always on";
    $("d-phase-s").textContent = "No heater cycle on this box, so carbon monoxide readings are indicative only.";
  } else if (co?.phase) {
    const len = co.phase === "H" ? 60 : 90, frac = Math.min((co.phase_s ?? 0) / len, 1);
    $("d-ring").setAttribute("class", "ring " + (co.phase === "H" ? "s-EarlyWarning" : "s-Safe"));
    $("d-ring-p").setAttribute("stroke-dashoffset", (264 * (1 - frac)).toFixed(1));
    $("d-phase").textContent = co.phase === "H" ? "CO heater: cleaning (high heat)" : "CO heater: measuring (low heat)";
    $("d-phase-s").textContent = `${co.phase_s} s of ${len}. ${co.phase === "H" ? "CO readings are held during cleaning." : "CO readings count in this phase."}`;
  }
  const learning = S.st?.learning || {};
  $("d-learn").innerHTML = ["CH4", "CO"].map(k => {
    const n = learning[k], done = S.st && n == null;
    return `<div>${NAMES[k]} clean-air baseline: <b>${!S.st ? "waiting" : done ? "learned" : `learning, ${n} of 30`}</b>
      <div class="bar"><i style="width:${done ? 100 : ((n || 0) / 30 * 100).toFixed(0)}%"></i></div></div>`;
  }).join("");
  const lv = S.st?.level;
  $("d-dist").innerHTML = lv?.dist_cm != null ? `${Math.round(lv.dist_cm)}<small>cm to the surface</small>` : "--";
  const chk = d.ops.live.checks || {};
  for (const [id, k] of [["d-bump", "bump"], ["d-alt", "alarm"]]) {
    const t = chk[k], age = t ? d.now - t : null;
    $(id).innerHTML = t == null ? `<span class="pill s-EarlyWarning">Never recorded</span>`
      : `<span class="pill ${age > 86400 ? "s-EarlyWarning" : "s-Safe"}">${age > 86400 ? "Due, last " + Math.floor(age / 86400) + " d ago" : "Passed at " + clock(t)}</span>`;
  }
  $("d-empty").textContent = d.config ? d.config.empty_cm + " cm" : "--";
  $("d-full").textContent = d.config ? d.config.full_cm + " cm" : "--";
}

// ---------- the drawing ----------
(function buildScene() {
  const wave = (amp, y0) => {
    let d = `M -200 ${y0}`;
    for (let x = -200; x < 1000; x += 140) d += ` q 35 ${-amp} 70 0 t 70 0`;
    return d + ` L 1000 ${FLOOR_Y + 10} L -200 ${FLOOR_Y + 10} Z`;
  };
  $("wave-a").setAttribute("d", wave(7, FULL_Y));
  $("wave-b").setAttribute("d", wave(5, FULL_Y - 4));
  const rnd = (a, b) => a + Math.random() * (b - a);
  let p = "", b = "";
  for (let i = 0; i < 26; i++) p += `<circle class="particle" cx="${rnd(96, 624).toFixed(0)}" cy="${rnd(470, 600).toFixed(0)}" r="${rnd(1.6, 3.6).toFixed(1)}" style="animation-duration:${rnd(6, 12).toFixed(1)}s;animation-delay:-${rnd(0, 12).toFixed(1)}s"/>`;
  for (let i = 0; i < 12; i++) b += `<circle class="bub" cx="${rnd(96, 624).toFixed(0)}" cy="${rnd(560, 610).toFixed(0)}" r="${rnd(2, 4.5).toFixed(1)}" style="animation-duration:${rnd(3, 7).toFixed(1)}s;animation-delay:-${rnd(0, 7).toFixed(1)}s"/>`;
  $("particles").innerHTML = p;
  $("bubbles").innerHTML = b;
})();

function scene(status, st, linked, pinged) {
  $("scene").setAttribute("class", cls(status) + (linked ? " linked" : ""));
  const fill = st?.level ? Math.max(0, Math.min(st.level.fill_pct ?? 0, 100)) : 30;
  const top = FLOOR_Y - (FLOOR_Y - FULL_Y) * fill / 100;
  $("waterg").style.transform = `translateY(${top - FULL_Y}px)`;
  $("airclip-r").setAttribute("height", Math.max(top - 190, 0));
  $("waterclip-r").setAttribute("y", top + 6);
  $("waterclip-r").setAttribute("height", Math.max(FLOOR_Y - top - 6, 0));
  $("beam").setAttribute("y2", Math.max(top - 6, 250));
  $("fill-t").textContent = st?.level ? `Sewage ${Math.round(fill)}% full` : "";
  $("fill-t").setAttribute("y", Math.min(top + 32, 592));
  const pcts = st ? Object.values(st.gases).filter(g => g.installed).map(g => g.pct || 0) : [];
  const worst = pcts.length ? Math.max(...pcts) : 0, live = st && status !== "Stale";
  $("haze").setAttribute("opacity", live ? Math.min(0.04 + worst / 100 * 0.5, 0.55).toFixed(2) : 0);
  $("particles").setAttribute("opacity", live ? Math.min(0.15 + worst / 100, 1).toFixed(2) : 0);
  const h = live ? headline(st) : null;
  let air = "";
  if (live) {
    const g = h.key && h.key !== "Level" ? st.gases[h.key] : null;
    air = g ? `Air: ${NAMES[h.key].toLowerCase()} ${g.status === "Critical" ? "at danger level" : "rising"}, ${pctTxt(g.pct)}` : "Air: normal";
  }
  fitText("air", "air-t", air, () => 100);
  const say = !live ? (mode === "sim" ? "" : "No data from the box")
    : status === "Critical" ? "Do not open: dangerous now"
    : status === "Safe" ? "" : `Do not open: ${h.eta ? "danger in " + h.eta : "gas rising"}`;
  fitText("bubble", "bubble-t", say, w => Math.min(Math.max(8, 205 - w / 2), 712 - w), true);
  if (pinged && linked && !reduce) {   // one packet and one blink per new reading
    $("packet").animate([{ transform: "translate(0,0)", opacity: 1 }, { transform: "translate(150px,-14px)", opacity: 1, offset: 0.85 }, { transform: "translate(178px,-17px)", opacity: 0 }],
      { duration: 800, easing: "cubic-bezier(0.3, 0, 0.2, 1)" });
    for (const id of ["box-led", "recv-led"]) $(id).animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], { duration: 400, delay: id === "recv-led" ? 650 : 0 });
  }
}

function fitText(groupId, textId, text, xFor, center) {
  const g = $(groupId), t = $(textId);
  g.setAttribute("visibility", text ? "visible" : "hidden");
  t.textContent = text;
  if (!text) return;
  const w = t.getComputedTextLength() + 36, x = xFor(w), r = g.querySelector("rect");
  r.setAttribute("x", x); r.setAttribute("width", w);
  t.setAttribute("x", center ? x + w / 2 : x + 18);
}

// ---------- render loop ----------
$("share").onclick = () => {
  $("qr").src = "/api/qr.svg?u=" + encodeURIComponent(last.public_url);   // new address, new image
  $("share-url").textContent = last.public_url;
  $("share-dlg").showModal();
};

function render(d) {
  last = d;
  document.body.classList.toggle("viewonly", !!d.view_only);
  $("vo").hidden = !d.view_only;
  $("share").hidden = d.view_only || !d.public_url;
  const S = source(d);
  const status = statusOf(S);
  $("ambient").className = "ambient " + cls(status);
  $("sim-note").textContent = mode === "sim" && d.sim.state
    ? `${d.sim.scenario.replace("_", " ")} on ${NAMES[d.sim.gas].toLowerCase()}, ${d.sim.speed}x speed, minute ${Math.floor(d.sim.t / 60)} of ${d.sim.duration / 60}${d.sim.running ? "" : ", finished"}`
    : "Generated readings run through the same prediction software.";
  const O = d.ops[mode];
  checkNewEvents(S, O);
  renderModebar(d, O);
  renderTakeover(O);
  if (view === "overview") renderOverview(d, S);
  else if (view === "work") renderWork(d, S, O);
  else if (view === "entry") renderEntry(d, S, O);
  else if (view === "analytics") renderAnalytics(d, S);
  else if (view === "alerts") { renderAlerts(S); renderLog(O); }
  else if (view === "device") renderDevice(d, S);
  if (mode === "sim") lastSimT = d.sim.t; else lastLines = d.live.lines;
}

async function tick() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    render(await r.json());
  } catch {
    $("why").textContent = "The receiver program is not responding. Restart it on the Pi or laptop.";
    $("word").textContent = "Offline";
    $("hero").className = "hero glass s-Stale";
  }
}

setMode(mode);
setView(location.hash.slice(1) === "sim" ? "overview" : location.hash.slice(1) || "overview");
tick();
setInterval(tick, 1000);
