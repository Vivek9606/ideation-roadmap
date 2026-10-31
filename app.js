// Betterhood growth roadmap. Static site: the roadmap lives in data/roadmap.json, discussions live in
// data/notes.json. Edits are kept as a local draft (a list of operations) until "Save to GitHub", which
// re-reads the latest notes.json, applies the draft on top and commits it with the user's message.
"use strict";

const CONFIG = { owner: "Vivek9606", repo: "ideation-roadmap", branch: "main", notesPath: "data/notes.json" };
const API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`;
const VIEWS = [["overview", "Overview"], ["roadmap", "Roadmap"], ["timeline", "Timeline"], ["channels", "Channels"], ["frameworks", "Frameworks"], ["discussion", "Discussion"], ["history", "History"]];
const STATUSES = ["Idea", "Planned", "In progress", "Done", "Parked"];
const STATUS_CLASS = { "Idea": "s-idea", "Planned": "s-planned", "In progress": "s-progress", "Done": "s-done", "Parked": "s-parked" };
const EMPTY_DOC = { version: 1, updatedAt: null, comments: {}, notes: {}, status: {}, owner: {}, ideas: [], meetings: [] };

const state = {
  rm: null,             // roadmap.json
  doc: structuredClone(EMPTY_DOC), // last known committed notes.json
  sha: null,
  ops: [],              // unsaved draft operations
  view: "overview",
  filter: { pillars: [], phase: "", surface: "", status: "", q: "", sort: "ice", framework: "" },
  drawer: null,         // open target, e.g. "init:s4"
  history: null,
};

/* ---------- storage (never trusted to exist) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k) ?? sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, persist = true) { try { (persist ? localStorage : sessionStorage).setItem(k, JSON.stringify(v)); (persist ? sessionStorage : localStorage).removeItem(k); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const settings = () => ({ name: store.get("rm.name", ""), token: store.get("rm.token", ""), remember: store.get("rm.remember", true) });

/* ---------- tiny DOM helper: text always goes in as text, never HTML ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k.startsWith("--")) el.style.setProperty(k, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };

/* ---------- the notes document: committed doc + draft ops ---------- */
function apply(base, ops) {
  const d = structuredClone({ ...EMPTY_DOC, ...base });
  for (const op of ops) {
    if (op.type === "comment") (d.comments[op.target] ||= []).push(op.entry);
    else if (op.type === "note") d.notes[op.target] = { text: op.text, by: op.by, at: op.at };
    else if (op.type === "status") d.status[op.target] = { value: op.value, by: op.by, at: op.at };
    else if (op.type === "owner") d.owner[op.target] = { value: op.value, by: op.by, at: op.at };
    else if (op.type === "idea") d.ideas.push(op.entry);
    else if (op.type === "meeting") d.meetings.push(op.entry);
  }
  return d;
}
const view = () => apply(state.doc, state.ops);
function addOp(op) {
  const me = settings().name || "Anonymous";
  op = { ...op, by: me, at: new Date().toISOString() };
  if (op.entry) op.entry = { id: uid(), by: me, at: op.at, ...op.entry };
  // A later note/status/owner edit on the same target replaces the earlier draft one.
  if (["note", "status", "owner"].includes(op.type)) state.ops = state.ops.filter((o) => !(o.type === op.type && o.target === op.target));
  state.ops.push(op);
  persistDraft();
  renderSavebar();
}
function dropOp(entryId) { state.ops = state.ops.filter((o) => o.entry?.id !== entryId); persistDraft(); renderSavebar(); }
const persistDraft = () => store.set("rm.draft", state.ops);
const isDraft = (entryId) => state.ops.some((o) => o.entry?.id === entryId);

function describe(op) {
  const name = targetName(op.target);
  switch (op.type) {
    case "comment": return `Comment on “${name}”`;
    case "note": return `Notes on “${name}”`;
    case "status": return `Status of “${name}” → ${op.value}`;
    case "owner": return `Owner of “${name}” → ${op.value || "nobody"}`;
    case "idea": return `New idea: “${op.entry.title}”`;
    case "meeting": return `Meeting notes: “${op.entry.title}”`;
  }
  return op.type;
}
function targetName(t) {
  if (!t) return "";
  const [kind, id] = t.split(":");
  if (kind === "init") return state.rm.initiatives.find((x) => x.id === id)?.title ?? id;
  if (kind === "channel") return state.rm.channels.find((x) => x.id === id)?.name ?? id;
  if (kind === "idea") return view().ideas.find((x) => x.id === id)?.title ?? id;
  if (kind === "general") return "General";
  return t;
}

/* ---------- GitHub ---------- */
function b64encode(str) { const bytes = new TextEncoder().encode(str); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); }
function b64decode(b64) { const bin = atob(b64.replace(/\n/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
async function gh(path, opts = {}) {
  const { token } = settings();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = `${res.status}: ${(await res.json()).message}`; } catch { /* no body */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json();
}
async function fetchRemoteNotes() {
  const r = await gh(`/contents/${CONFIG.notesPath}?ref=${CONFIG.branch}&t=${Date.now()}`);
  return { doc: { ...EMPTY_DOC, ...JSON.parse(b64decode(r.content)) }, sha: r.sha };
}
async function commit(message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let remote = { doc: structuredClone(EMPTY_DOC), sha: undefined };
    try { remote = await fetchRemoteNotes(); } catch (e) { if (e.status !== 404) throw e; }
    const next = apply(remote.doc, state.ops);
    next.updatedAt = new Date().toISOString();
    try {
      const r = await gh(`/contents/${CONFIG.notesPath}`, { method: "PUT", body: JSON.stringify({ message, content: b64encode(JSON.stringify(next, null, 2) + "\n"), sha: remote.sha, branch: CONFIG.branch }) });
      state.doc = next; state.sha = r.content.sha; state.ops = []; persistDraft();
      return r.commit;
    } catch (e) {
      // Someone saved in between: re-read and re-apply once.
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
      throw e;
    }
  }
}

/* ---------- boot ---------- */
async function boot() {
  applyTheme(store.get("rm.theme", ""));
  state.ops = store.get("rm.draft", []);
  try {
    state.rm = await (await fetch(`data/roadmap.json?v=${Date.now()}`)).json();
  } catch {
    $("#main").replaceChildren(h("div", { class: "loading" }, "Couldn't load data/roadmap.json. Open this through a web server (GitHub Pages or `npx serve`), not as a file."));
    return;
  }
  try { const r = await fetchRemoteNotes(); state.doc = r.doc; state.sha = r.sha; }
  catch { try { state.doc = { ...EMPTY_DOC, ...(await (await fetch(`data/notes.json?v=${Date.now()}`)).json()) }; } catch { /* start empty */ } }
  wireChrome();
  route();
  window.addEventListener("hashchange", route);
  renderSavebar();
}

function route() {
  const [v, item] = location.hash.replace(/^#/, "").split("/");
  state.view = VIEWS.some(([k]) => k === v) ? v : "overview";
  if (!item && state.drawer) { state.drawer = null; $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; }
  renderTabs();
  renderMain();
  if (item) openDrawer(decodeURIComponent(item));
}

/* ---------- chrome ---------- */
function renderTabs() {
  $("#tabs").replaceChildren(...VIEWS.map(([k, l]) => h("a", { class: "tab", href: `#${k}`, "aria-current": state.view === k ? "page" : null }, l)));
}
function wireChrome() {
  $("#themeBtn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(dark ? "light" : "dark");
  });
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#saveBtn").addEventListener("click", openCommit);
  $("#discardBtn").addEventListener("click", () => {
    if (!confirm(`Discard ${state.ops.length} unsaved change${state.ops.length === 1 ? "" : "s"}?`)) return;
    state.ops = []; persistDraft(); renderSavebar(); renderMain(); if (state.drawer) openDrawer(state.drawer);
  });
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeDrawer));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.drawer && !document.querySelector("dialog[open]")) closeDrawer(); });
  document.querySelectorAll("dialog [data-cancel]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#testBtn").addEventListener("click", testConnection);
  $("#commitForm").addEventListener("submit", doCommit);
  window.addEventListener("beforeunload", (e) => { if (state.ops.length) { e.preventDefault(); e.returnValue = ""; } });
}
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  store.set("rm.theme", t);
}
function renderSavebar() {
  const n = state.ops.length;
  $("#savebar").hidden = !n;
  $("#savebarText").textContent = `${n} unsaved change${n === 1 ? "" : "s"}`;
}
function toast(content, ms = 4200) {
  const t = $("#toast");
  t.replaceChildren(...[content].flat());
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- derived data ---------- */
const pillar = (id) => state.rm.pillars.find((p) => p.id === id) || { name: id, color: "#888" };
const phase = (id) => state.rm.phases.find((p) => p.id === id) || { name: id, window: "" };
const iceScore = (i) => (i.ice ? Math.round((i.ice[0] + i.ice[1] + i.ice[2]) / 3 * 10) / 10 : null);
function allItems() {
  const v = view();
  const base = state.rm.initiatives.map((i) => ({ ...i, key: `init:${i.id}`, proposed: false }));
  const ideas = v.ideas.map((i) => ({ ...i, key: `idea:${i.id}`, proposed: true, steps: [], precedent: [], frameworks: [], kpis: [], surface: i.surface || "Website" }));
  return [...base, ...ideas].map((i) => ({ ...i, status: v.status[i.key]?.value || "Idea", owner: v.owner[i.key]?.value || "", comments: (v.comments[i.key] || []).length, hasNotes: !!v.notes[i.key]?.text }));
}

/* ---------- main views ---------- */
function renderMain() {
  const fn = { overview: Overview, roadmap: Roadmap, timeline: Timeline, channels: Channels, frameworks: Frameworks, discussion: Discussion, history: History }[state.view];
  $("#main").replaceChildren(h("div", { class: "view" }, fn()));
}

function Overview() {
  const rm = state.rm;
  const items = allItems();
  const byStatus = (s) => items.filter((i) => i.status === s).length;
  const top = [...items].filter((i) => i.ice).sort((a, b) => iceScore(b) - iceScore(a)).slice(0, 8);
  return [
    h("section", { class: "hero" },
      h("div", { class: "hero-main" },
        h("h1", {}, rm.meta.title),
        h("p", {}, rm.meta.subtitle),
        h("div", { class: "ns" },
          h("div", { class: "ns-label" }, "North Star metric"),
          h("div", { class: "ns-name" }, rm.meta.northStar.name),
          h("p", {}, rm.meta.northStar.definition),
          h("p", { style: { marginTop: "8px", opacity: ".8" } }, rm.meta.northStar.why))),
      h("div", { class: "stats" },
        stat(items.length, "Initiatives"), stat(rm.channels.length, "Channels"),
        stat(byStatus("In progress"), "In progress"), stat(byStatus("Done"), "Done"),
        stat(rm.frameworks.length, "Proven frameworks"), stat(Object.values(view().comments).reduce((n, l) => n + l.length, 0), "Comments"))),

    h("section", { class: "section" },
      head("Phases", "Click a phase to see its initiatives on the timeline"),
      h("div", { class: "phases" }, rm.phases.map((p, k) => {
        const its = items.filter((i) => i.phase === p.id);
        return h("a", { class: "phase card click", href: "#timeline", style: { textDecoration: "none", color: "inherit" } },
          h("div", { class: "phase-n" }, `Phase ${k} · ${p.window}`),
          h("h3", {}, p.name), h("p", {}, p.focus),
          h("div", { class: "bar", title: "Initiatives by pillar" }, rm.pillars.map((pl) => {
            const n = its.filter((i) => i.pillar === pl.id).length;
            return n ? h("i", { style: { width: `${(n / its.length) * 100}%`, background: pl.color }, title: `${pl.name}: ${n}` }) : null;
          })),
          h("p", { class: "small-text" }, `${its.length} initiatives`));
      }))),

    h("section", { class: "section" },
      head("Pillars", "What each area is trying to win"),
      h("div", { class: "grid g3" }, rm.pillars.map((p) => {
        const n = items.filter((i) => i.pillar === p.id).length;
        return h("button", { class: "card click item", type: "button", "--pc": p.color, onclick: () => { state.filter = { ...state.filter, pillars: [p.id] }; location.hash = "roadmap"; } },
          h("div", { class: "meta-row" }, h("span", { class: "pill" }, h("span", { class: "dot", style: { background: p.color } }), p.name), h("span", { class: "small-text" }, `${n} initiatives`)),
          h("h3", {}, p.goal), h("p", {}, p.summary));
      }))),

    h("section", { class: "section" },
      head("Highest ICE scores", "Impact × Confidence × Ease, averaged. Re-score in the weekly growth meeting."),
      h("div", { class: "grid g2" }, top.map(ItemCard))),

    h("section", { class: "section" },
      head("KPIs", "Targets are suggestions to agree at kickoff, against Search Console and tracker baselines"),
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Metric"), h("th", {}, "Pillar"), h("th", {}, "Source"), h("th", {}, "Target"))),
        h("tbody", {}, rm.kpis.map((k) => h("tr", {}, h("td", {}, h("b", {}, k.name)), h("td", {}, pillar(k.pillar).name), h("td", {}, k.source), h("td", {}, k.target))))))),

    h("section", { class: "section two" },
      h("div", {}, head("What we already have"), h("div", { class: "card" }, h("ul", { style: { margin: 0, paddingLeft: "18px", display: "grid", gap: "6px" } }, rm.meta.assets.map((a) => h("li", {}, a))))),
      h("div", {}, head("Who we're growing with"), h("div", { class: "grid", style: { gap: "10px" } }, rm.meta.audiences.map((a) => h("div", { class: "card", style: { padding: "14px" } }, h("b", {}, a.name), h("p", { class: "muted", style: { fontSize: "14px" } }, a.need)))),
        h("p", { class: "small-text", style: { marginTop: "12px" } }, `Competitors tracked: ${rm.meta.competitors.join(", ")}`))),
  ];
}
const stat = (n, l) => h("div", { class: "stat" }, h("b", {}, n), h("span", {}, l));
const head = (title, sub) => h("div", { class: "section-head" }, h("h2", {}, title), sub ? h("p", { class: "small-text" }, sub) : null);

function ItemCard(i) {
  const p = pillar(i.pillar);
  return h("button", { class: "card click item", type: "button", "--pc": p.color, onclick: () => openDrawer(i.key) },
    h("div", { class: "meta-row" },
      h("span", { class: "pill" }, h("span", { class: "dot", style: { background: p.color } }), p.name),
      h("span", { class: "pill" }, phase(i.phase).name),
      h("span", { class: `pill ${STATUS_CLASS[i.status]}` }, i.status),
      i.proposed ? h("span", { class: "pill prop" }, "Proposed") : null),
    h("h3", {}, i.title),
    h("p", {}, i.summary),
    h("div", { class: "item-foot" },
      h("div", { class: "counts" }, h("span", {}, i.surface), i.owner ? h("span", {}, `· ${i.owner}`) : null, i.comments ? h("span", {}, `· 💬 ${i.comments}`) : null, i.hasNotes ? h("span", {}, "· 📝") : null),
      i.ice ? h("span", { class: "ice", title: `Impact ${i.ice[0]} · Confidence ${i.ice[1]} · Ease ${i.ice[2]}` }, iceScore(i), h("small", {}, "ICE")) : null));
}

function Roadmap() {
  const f = state.filter;
  const rm = state.rm;
  let items = allItems().filter((i) =>
    (!f.pillars.length || f.pillars.includes(i.pillar)) && (!f.phase || i.phase === f.phase) && (!f.surface || i.surface === f.surface) &&
    (!f.status || i.status === f.status) && (!f.framework || (i.frameworks || []).includes(f.framework)) &&
    (!f.q || `${i.title} ${i.summary} ${i.why || ""} ${(i.steps || []).join(" ")}`.toLowerCase().includes(f.q.toLowerCase())));
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  items.sort(f.sort === "phase" ? (a, b) => order[a.phase] - order[b.phase] || (iceScore(b) ?? 0) - (iceScore(a) ?? 0)
    : f.sort === "pillar" ? (a, b) => a.pillar.localeCompare(b.pillar) || (iceScore(b) ?? 0) - (iceScore(a) ?? 0)
    : (a, b) => (iceScore(b) ?? 0) - (iceScore(a) ?? 0));
  const set = (patch) => { state.filter = { ...state.filter, ...patch }; renderMain(); };
  const surfaces = [...new Set(allItems().map((i) => i.surface))];
  const fw = f.framework && rm.frameworks.find((x) => x.id === f.framework);
  const search = h("input", { type: "search", placeholder: "Search initiatives…", value: f.q, "aria-label": "Search initiatives" });
  search.addEventListener("input", debounce(() => { state.filter.q = search.value; const pos = search.selectionStart; renderMain(); const s = $("#main input[type=search]"); s.focus(); s.setSelectionRange(pos, pos); }, 200));
  return [
    h("div", { class: "section-head" }, h("h2", {}, "Roadmap"), h("button", { class: "btn primary small", type: "button", onclick: () => { location.hash = "discussion"; setTimeout(() => $("#ideaTitle")?.focus(), 300); } }, "+ Propose an idea")),
    h("div", { class: "filters" },
      h("div", { class: "filter-row" }, rm.pillars.map((p) => h("button", { class: "chip", type: "button", "aria-pressed": String(f.pillars.includes(p.id)), onclick: () => set({ pillars: f.pillars.includes(p.id) ? f.pillars.filter((x) => x !== p.id) : [...f.pillars, p.id] }) }, h("span", { class: "dot", style: { background: p.color } }), p.name))),
      h("div", { class: "filter-row" },
        search,
        select("Phase", f.phase, [["", "All phases"], ...rm.phases.map((p) => [p.id, `${p.name} (${p.window})`])], (v) => set({ phase: v })),
        select("Surface", f.surface, [["", "All surfaces"], ...surfaces.map((s) => [s, s])], (v) => set({ surface: v })),
        select("Status", f.status, [["", "Any status"], ...STATUSES.map((s) => [s, s])], (v) => set({ status: v })),
        select("Sort", f.sort, [["ice", "Sort: ICE score"], ["phase", "Sort: phase"], ["pillar", "Sort: pillar"]], (v) => set({ sort: v }))),
      fw ? h("div", { class: "filter-row" }, h("span", { class: "pill brand" }, `Framework: ${fw.name}`), h("button", { class: "btn ghost small", type: "button", onclick: () => set({ framework: "" }) }, "Clear")) : null,
      (f.pillars.length || f.phase || f.surface || f.status || f.q) ? h("div", { class: "filter-row" }, h("span", { class: "small-text" }, `${items.length} shown`), h("button", { class: "btn ghost small", type: "button", onclick: () => set({ pillars: [], phase: "", surface: "", status: "", q: "", framework: "" }) }, "Clear filters")) : null),
    items.length ? h("div", { class: "grid g2", style: { marginTop: "16px" } }, items.map(ItemCard)) : h("div", { class: "empty" }, "Nothing matches these filters."),
  ];
}
function select(label, value, options, onChange) {
  const s = h("select", { "aria-label": label, onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h("option", { value: v }, l)));
  s.value = value;
  return s;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function Timeline() {
  const items = allItems();
  return [
    head("Timeline", "Four phases over 12 months. Cards are coloured by pillar and sorted by ICE score."),
    h("div", { class: "board" }, state.rm.phases.map((p) =>
      h("div", { class: "col" },
        h("div", { class: "col-head" }, h("h3", {}, p.name), h("p", {}, `${p.window} · ${p.focus}`)),
        items.filter((i) => i.phase === p.id).sort((a, b) => (iceScore(b) ?? 0) - (iceScore(a) ?? 0)).map((i) =>
          h("button", { class: "mini", type: "button", "--pc": pillar(i.pillar).color, onclick: () => openDrawer(i.key) },
            h("b", {}, i.title),
            h("span", {}, `${pillar(i.pillar).name} · ${i.status}${i.ice ? ` · ICE ${iceScore(i)}` : ""}${i.comments ? ` · 💬 ${i.comments}` : ""}`)))))),
    h("div", { class: "meta-row", style: { marginTop: "16px" } }, state.rm.pillars.map((p) => h("span", { class: "pill" }, h("span", { class: "dot", style: { background: p.color } }), p.name))),
  ];
}

function Channels() {
  const groups = ["Core", "Grow", "Maintain", "Test", "Later"];
  const v = view();
  return [
    head("Channels", "Every platform relevant to Betterhood, with its job, format, cadence and precedent. Click one to discuss it."),
    groups.map((g) => {
      const list = state.rm.channels.filter((c) => c.priority === g);
      if (!list.length) return null;
      return h("section", { class: "section", style: { marginTop: "22px" } },
        h("h3", { style: { fontSize: "15px", marginBottom: "10px", color: "var(--ink-2)" } }, { Core: "Core: invest every week", Grow: "Grow: build steadily", Maintain: "Maintain: repurpose only", Test: "Test: 8-week experiments", Later: "Later: low fit right now" }[g]),
        h("div", { class: "grid g3" }, list.map((c) => {
          const n = (v.comments[`channel:${c.id}`] || []).length;
          return h("button", { class: "card click item", type: "button", onclick: () => openDrawer(`channel:${c.id}`) },
            h("div", { class: "meta-row" }, h("span", { class: "pill brand" }, c.priority), n ? h("span", { class: "small-text" }, `💬 ${n}`) : null),
            h("h3", {}, c.name), h("p", {}, c.role),
            h("p", { class: "small-text" }, `${c.cadence} · ${c.kpis}`));
        })));
    }),
  ];
}

function Frameworks() {
  const items = allItems();
  return [
    head("Frameworks behind the plan", "Each one has worked for other companies. Click one to see the initiatives that use it."),
    h("div", { class: "grid g2" }, state.rm.frameworks.map((f) => {
      const n = items.filter((i) => (i.frameworks || []).includes(f.id)).length;
      return h("button", { class: "card click item", type: "button", onclick: () => { state.filter = { ...state.filter, framework: f.id, pillars: [], phase: "", surface: "", status: "", q: "" }; location.hash = "roadmap"; } },
        h("div", { class: "meta-row" }, h("span", { class: "pill" }, f.origin), h("span", { class: "small-text" }, `${n} initiative${n === 1 ? "" : "s"}`)),
        h("h3", {}, f.name), h("p", {}, f.summary),
        h("p", { style: { color: "var(--ink)" } }, h("b", {}, "How we use it: "), f.howWeUse));
    })),
  ];
}

function Discussion() {
  const v = view();
  const me = settings().name;
  const mTitle = h("input", { placeholder: "e.g. SEO sync with the content team", maxlength: 120, id: "meetTitle" });
  const mDate = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const mWho = h("input", { placeholder: "Who was there" });
  const mBody = h("textarea", { placeholder: "Decisions, open questions, action items…", rows: 6 });
  const iTitle = h("input", { placeholder: "A short name for the idea", maxlength: 120, id: "ideaTitle" });
  const iSummary = h("textarea", { placeholder: "What is it, and why could it work?", rows: 4 });
  const iPillar = select("Pillar", "seo", state.rm.pillars.map((p) => [p.id, p.name]), () => {});
  const iPhase = select("Phase", "p1", state.rm.phases.map((p) => [p.id, `${p.name} (${p.window})`]), () => {});
  const iSurface = select("Surface", "Website", ["Website", "App", "Website + App", "Social", "Ops"].map((s) => [s, s]), () => {});
  const ice = ["Impact", "Confidence", "Ease"].map((l) => h("input", { type: "number", min: 1, max: 10, value: 5, "aria-label": l, title: l }));
  const general = "general:discussion";

  return [
    head("Discussion", "Meeting notes and new ideas from conversations. Everything is committed to git when you save."),
    !me ? h("div", { class: "card", style: { marginBottom: "16px" } }, "Add your name in ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); openSettings(); } }, "Settings"), " so your notes are attributed to you.") : null,
    h("div", { class: "two" },
      h("div", { class: "card" },
        h("h3", {}, "Add meeting notes"),
        h("label", { class: "field" }, h("span", {}, "Title"), mTitle),
        h("div", { class: "controls" }, h("label", {}, "Date", mDate), h("label", {}, "Attendees", mWho)),
        h("label", { class: "field" }, h("span", {}, "Notes"), mBody),
        h("div", { class: "modal-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => {
          if (!mTitle.value.trim() || !mBody.value.trim()) return toast("Add a title and some notes first.");
          addOp({ type: "meeting", entry: { title: mTitle.value.trim(), date: mDate.value, attendees: mWho.value.trim(), body: mBody.value.trim() } });
          renderMain(); toast("Added to your draft. Save to GitHub when you're done.");
        } }, "Add to draft"))),
      h("div", { class: "card" },
        h("h3", {}, "Propose an idea"),
        h("label", { class: "field" }, h("span", {}, "Idea"), iTitle),
        h("label", { class: "field" }, h("span", {}, "Summary"), iSummary),
        h("div", { class: "controls" }, h("label", {}, "Pillar", iPillar), h("label", {}, "Phase", iPhase)),
        h("div", { class: "controls" }, h("label", {}, "Surface", iSurface), h("label", {}, "ICE (1–10 each)", h("div", { class: "ice-grid" }, ice))),
        h("div", { class: "modal-actions" }, h("button", { class: "btn primary", type: "button", onclick: () => {
          if (!iTitle.value.trim()) return toast("Give the idea a name first.");
          const clamp = (x) => Math.max(1, Math.min(10, Number(x.value) || 5));
          addOp({ type: "idea", entry: { title: iTitle.value.trim(), summary: iSummary.value.trim(), pillar: iPillar.value, phase: iPhase.value, surface: iSurface.value, ice: ice.map(clamp) } });
          renderMain(); toast("Idea added to the roadmap draft.");
        } }, "Add to roadmap")))),

    h("section", { class: "section" },
      head("General thread", "Running conversation that isn't about one initiative"),
      Thread(general)),

    h("section", { class: "section" },
      head("Meeting log", `${v.meetings.length} meeting${v.meetings.length === 1 ? "" : "s"}`),
      v.meetings.length ? h("div", { class: "grid", style: { gap: "12px" } }, [...v.meetings].sort((a, b) => (b.date || b.at).localeCompare(a.date || a.at)).map((m) =>
        h("div", { class: `card meeting${isDraft(m.id) ? " comment pending" : ""}` },
          h("div", { class: "meta-row" }, h("span", { class: "pill brand" }, m.date || when(m.at)), m.attendees ? h("span", { class: "small-text" }, m.attendees) : null, isDraft(m.id) ? h("span", { class: "pill prop" }, "Unsaved") : null),
          h("h3", {}, m.title), h("div", { class: "body" }, m.body),
          h("div", { class: "comment-head" }, h("span", {}, `Added by ${m.by} · ${when(m.at)}`), isDraft(m.id) ? h("button", { class: "linkish", type: "button", onclick: () => { dropOp(m.id); renderMain(); } }, "Remove") : null))))
        : h("div", { class: "empty card" }, "No meeting notes yet.")),
  ];
}

function History() {
  const box = h("div", { class: "grid", style: { gap: "12px" } }, h("div", { class: "empty" }, "Loading commits…"));
  gh(`/commits?path=${encodeURIComponent(CONFIG.notesPath)}&sha=${CONFIG.branch}&per_page=40`).then((list) => {
    box.replaceChildren(...(list.length ? list.map((c) => h("div", { class: "card commit" },
      h("span", { class: "commit-dot" }),
      h("div", { style: { flex: 1 } },
        h("b", {}, c.commit.message.split("\n")[0]),
        h("span", { class: "small-text" }, `${c.commit.author?.name ?? c.author?.login ?? "someone"} · ${when(c.commit.author?.date)}`)),
      h("a", { class: "btn ghost small", href: c.html_url, target: "_blank", rel: "noopener" }, "View diff"))) : [h("div", { class: "empty" }, "No saved discussions yet.")]));
  }).catch((e) => box.replaceChildren(h("div", { class: "empty card" }, `Couldn't load history (${e.message}). If the repository is private, add a token in Settings.`)));
  return [
    head("History", "Every save is a git commit on data/notes.json"),
    h("p", { class: "small-text", style: { marginBottom: "14px" } }, "Full history on GitHub: ", h("a", { href: `https://github.com/${CONFIG.owner}/${CONFIG.repo}/commits/${CONFIG.branch}/${CONFIG.notesPath}`, target: "_blank", rel: "noopener" }, `${CONFIG.owner}/${CONFIG.repo}`)),
    box,
  ];
}

/* ---------- drawer ---------- */
function openDrawer(target) {
  state.drawer = target;
  const body = $("#drawerBody");
  const [kind, id] = target.split(":");
  let content;
  if (kind === "channel") content = ChannelDetail(state.rm.channels.find((c) => c.id === id));
  else content = ItemDetail(allItems().find((i) => i.key === target));
  if (!content) return;
  body.replaceChildren(...[content].flat());
  const d = $("#drawer");
  d.classList.add("open"); d.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  $(".drawer-panel").scrollTop = 0;
  history.replaceState(null, "", `#${state.view}/${encodeURIComponent(target)}`);
}
function closeDrawer() {
  state.drawer = null;
  const d = $("#drawer");
  d.classList.remove("open"); d.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  history.replaceState(null, "", `#${state.view}`);
  renderMain();
}

function ItemDetail(i) {
  if (!i) return null;
  const p = pillar(i.pillar);
  const fws = (i.frameworks || []).map((f) => state.rm.frameworks.find((x) => x.id === f)).filter(Boolean);
  const kpis = (i.kpis || []).map((k) => state.rm.kpis.find((x) => x.id === k)).filter(Boolean);
  return [
    h("div", { class: "meta-row" },
      h("span", { class: "pill" }, h("span", { class: "dot", style: { background: p.color } }), p.name),
      h("span", { class: "pill" }, `${phase(i.phase).name} · ${phase(i.phase).window}`),
      h("span", { class: "pill" }, i.surface),
      i.proposed ? h("span", { class: "pill prop" }, `Proposed by ${i.by}`) : null),
    h("h2", { class: "d-title", id: "drawerTitle" }, i.title),
    h("p", { class: "muted" }, i.summary),
    Controls(i.key, i.status, i.owner),
    i.ice ? h("div", { class: "d-sec" }, h("h4", {}, `ICE score ${iceScore(i)}`), h("div", { class: "ice-grid" }, ["Impact", "Confidence", "Ease"].map((l, k) => h("div", { class: "ice-cell" }, h("b", {}, i.ice[k]), h("span", {}, l))))) : null,
    i.why ? h("div", { class: "d-sec" }, h("h4", {}, "Why it matters"), h("p", {}, i.why)) : null,
    i.steps?.length ? h("div", { class: "d-sec" }, h("h4", {}, "How to do it"), h("ol", {}, i.steps.map((s) => h("li", {}, s)))) : null,
    i.precedent?.length ? h("div", { class: "d-sec" }, h("h4", {}, "Who did this before"), i.precedent.map((x) => h("div", { class: "prec" }, h("b", {}, x.name), h("p", {}, x.lesson)))) : null,
    fws.length ? h("div", { class: "d-sec" }, h("h4", {}, "Frameworks"), fws.map((f) => h("div", { class: "prec" }, h("b", {}, `${f.name} · ${f.origin}`), h("p", {}, f.howWeUse)))) : null,
    kpis.length ? h("div", { class: "d-sec" }, h("h4", {}, "Measured by"), h("ul", {}, kpis.map((k) => h("li", {}, h("b", {}, k.name), ` · ${k.source}`)))) : null,
    NotesBox(i.key),
    h("div", { class: "d-sec" }, h("h4", {}, "Comments"), Thread(i.key)),
  ];
}
function ChannelDetail(c) {
  if (!c) return null;
  const key = `channel:${c.id}`;
  const v = view();
  const related = allItems().filter((i) => i.pillar === "social" && `${i.title} ${i.summary}`.toLowerCase().includes(c.name.split(" ")[0].toLowerCase()));
  return [
    h("div", { class: "meta-row" }, h("span", { class: "pill brand" }, c.priority), h("span", { class: "pill" }, "Channel")),
    h("h2", { class: "d-title", id: "drawerTitle" }, c.name),
    h("p", { class: "muted" }, c.role),
    Controls(key, v.status[key]?.value || "Idea", v.owner[key]?.value || ""),
    h("div", { class: "d-sec" }, h("h4", {}, "Audience"), h("p", {}, c.audience)),
    h("div", { class: "d-sec" }, h("h4", {}, "Formats"), h("div", { class: "meta-row" }, c.formats.map((f) => h("span", { class: "pill" }, f)))),
    h("div", { class: "d-sec" }, h("h4", {}, "Cadence and KPIs"), h("p", {}, c.cadence), h("p", { class: "muted" }, c.kpis)),
    c.ideas.length ? h("div", { class: "d-sec" }, h("h4", {}, "Content ideas"), h("ul", {}, c.ideas.map((x) => h("li", {}, x)))) : null,
    h("div", { class: "d-sec" }, h("h4", {}, "Precedent"), h("div", { class: "prec" }, h("p", {}, c.precedent))),
    related.length ? h("div", { class: "d-sec" }, h("h4", {}, "Related initiatives"), related.map((i) => h("button", { class: "mini", type: "button", "--pc": pillar(i.pillar).color, style: { marginTop: "8px" }, onclick: () => openDrawer(i.key) }, h("b", {}, i.title), h("span", {}, phase(i.phase).name)))) : null,
    NotesBox(key),
    h("div", { class: "d-sec" }, h("h4", {}, "Comments"), Thread(key)),
  ];
}

function Controls(key, status, owner) {
  const s = select("Status", status, STATUSES.map((x) => [x, x]), (val) => { addOp({ type: "status", target: key, value: val }); toast(`Status → ${val} (unsaved)`); });
  const o = h("input", { value: owner, placeholder: "Who owns this?", maxlength: 60, "aria-label": "Owner" });
  o.addEventListener("change", () => addOp({ type: "owner", target: key, value: o.value.trim() }));
  return h("div", { class: "controls" }, h("label", {}, "Status", s), h("label", {}, "Owner", o));
}
function NotesBox(key) {
  const v = view();
  const cur = v.notes[key];
  const t = h("textarea", { rows: 5, placeholder: "Working notes for this item: decisions, numbers, links…" });
  t.value = cur?.text || "";
  const meta = h("p", { class: "small-text", style: { marginTop: "6px" } }, cur?.at ? `Last edited by ${cur.by} · ${when(cur.at)}` : "No notes yet.");
  t.addEventListener("input", debounce(() => { addOp({ type: "note", target: key, text: t.value }); meta.textContent = "Edited · unsaved"; }, 400));
  return h("div", { class: "d-sec" }, h("h4", {}, "Notes"), t, meta);
}
function Thread(key) {
  const wrap = h("div", { class: "thread" });
  const draw = () => {
    const list = view().comments[key] || [];
    const input = h("textarea", { rows: 3, placeholder: settings().name ? "Add a comment…" : "Add a comment (set your name in Settings first)…" });
    const add = () => {
      if (!input.value.trim()) return;
      addOp({ type: "comment", target: key, entry: { text: input.value.trim() } });
      draw();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(); });
    wrap.replaceChildren(
      ...(list.length ? list.map((c) => h("div", { class: `comment${isDraft(c.id) ? " pending" : ""}` },
        h("div", { class: "comment-head" }, h("b", {}, c.by), h("span", {}, isDraft(c.id) ? "unsaved" : when(c.at))),
        h("p", {}, c.text),
        isDraft(c.id) ? h("button", { class: "linkish", type: "button", onclick: () => { dropOp(c.id); draw(); } }, "Remove") : null)) : [h("p", { class: "small-text" }, "No comments yet.")]),
      h("div", { class: "comment-form" }, input, h("div", { class: "row" }, h("span", { class: "small-text" }, "Ctrl/⌘ + Enter to add"), h("button", { class: "btn primary small", type: "button", onclick: add }, "Add comment"))));
  };
  draw();
  return wrap;
}

/* ---------- settings ---------- */
function openSettings() {
  const s = settings();
  $("#setName").value = s.name; $("#setToken").value = s.token; $("#setRemember").checked = s.remember;
  $("#setStatus").hidden = true;
  $("#settingsModal").showModal();
}
function saveSettings(e) {
  e.preventDefault();
  const remember = $("#setRemember").checked;
  store.set("rm.remember", remember);
  store.set("rm.name", $("#setName").value.trim());
  const token = $("#setToken").value.trim();
  if (token) store.set("rm.token", token, remember); else store.del("rm.token");
  $("#settingsModal").close();
  toast("Settings saved.");
  if (state.view === "discussion") renderMain();
}
async function testConnection() {
  const out = $("#setStatus");
  const prev = store.get("rm.token", "");
  const token = $("#setToken").value.trim();
  out.hidden = false; out.style.color = ""; out.textContent = "Checking…";
  store.set("rm.token", token, false);
  try {
    const r = await gh("");
    const ok = r.permissions?.push;
    out.style.color = ok ? "var(--ok)" : "var(--danger)";
    out.textContent = ok ? `Connected to ${r.full_name}. You can save.` : `Connected to ${r.full_name}, but this token can't write. Give it Contents: Read and write.`;
  } catch (e) {
    out.style.color = "var(--danger)";
    out.textContent = `Couldn't connect (${e.message}). Check the token and its repository access.`;
  } finally {
    if (prev) store.set("rm.token", prev, store.get("rm.remember", true)); else store.del("rm.token");
  }
}

/* ---------- commit ---------- */
function openCommit() {
  if (!state.ops.length) return;
  if (!settings().token) { toast("Add a GitHub token in Settings to save."); openSettings(); return; }
  $("#commitTarget").textContent = `${CONFIG.owner}/${CONFIG.repo}@${CONFIG.branch}`;
  $("#commitSummary").replaceChildren(...state.ops.map((o) => h("li", {}, describe(o))));
  const first = state.ops[0];
  $("#commitMsg").value = "";
  $("#commitMsg").placeholder = state.ops.length === 1 ? describe(first) : `${describe(first)} and ${state.ops.length - 1} more`;
  $("#commitError").hidden = true;
  $("#commitGo").disabled = false; $("#commitGo").textContent = "Commit & save";
  $("#commitModal").showModal();
  setTimeout(() => $("#commitMsg").focus(), 50);
}
async function doCommit(e) {
  e.preventDefault();
  const msg = $("#commitMsg").value.trim();
  if (!msg) { $("#commitMsg").focus(); return; }
  const go = $("#commitGo");
  go.disabled = true; go.textContent = "Committing…";
  try {
    const name = settings().name;
    const c = await commit(name ? `${msg}\n\nNotes by ${name} via the roadmap dashboard` : msg);
    $("#commitModal").close();
    renderSavebar(); renderMain(); if (state.drawer) openDrawer(state.drawer);
    toast(["Saved as commit ", h("a", { href: c.html_url, target: "_blank", rel: "noopener" }, c.sha.slice(0, 7))], 7000);
  } catch (err) {
    const out = $("#commitError");
    out.hidden = false;
    out.textContent = err.status === 401 || err.status === 403 ? `GitHub refused the token (${err.message}). Check it in Settings.` : err.status === 404 ? "Repository or branch not found, or the token can't see it." : `Couldn't save: ${err.message}`;
    go.disabled = false; go.textContent = "Try again";
  }
}

boot();
