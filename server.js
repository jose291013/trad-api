// server.js
import express from "express";
import { Pool } from "pg";
import crypto from "node:crypto";
import cors from "cors";

const app = express();
app.use(express.json());

/* ======================  CORS  ====================== */
// ALLOWED_ORIGINS (ENV) : "https://decoration.ams.v6.pressero.com,https://autre-domaine.fr"
const allowList = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const localOK = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman/curl
    const ok = localOK.some(rx => rx.test(origin)) || allowList.includes(origin);
    cb(ok ? null : new Error("CORS blocked"), ok);
  },
  credentials: false
};

// Bypass CORS pour le back-office (same-origin)
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  return cors(corsOptions)(req, res, next);
});

/* ======================  Auth  ====================== */
// API publique (hors /admin) via Bearer ${API_TOKEN}
// API publique (hors /admin) via Bearer ${API_TOKEN}  + whitelist /health, /healthz et /
// remplace ton middleware API publique par :
const API_TOKEN = process.env.API_TOKEN;
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  if (req.path === "/health" || req.path === "/healthz" || req.path === "/") return next();
  if (!API_TOKEN) return next();
  const header = req.get("Authorization") || "";
  if (header === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

app.get("/health", (_req,res)=>res.send("OK"));
app.get("/healthz", (_req,res)=>res.send("OK"));
app.get("/", (_req,res)=>res.send("OK"));



// Admin via Bearer ${ADMIN_TOKEN} ou ?token=... (pratique en iframe)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(500).json({ error: "ADMIN_TOKEN not set" });
  const header = req.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.query.token || req.body?.token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized (admin)" });
}

/* ======================  Back-office HTML  ====================== */

// 1) Déclare l'HTML hors de la route, en String.raw pour éviter les surprises
const ADMIN_HTML = String.raw`<!doctype html>
<html lang="fr"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Back-office Traductions</title>
  <style>
    body{font:14px/1.4 system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:20px;max-width:1100px}
    header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    input,select,button,textarea{padding:8px;border:1px solid #ccc;border-radius:8px}
    button{cursor:pointer}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
    tr:hover{background:#fafafa}
    .row{display:flex;gap:8px;flex-wrap:wrap}
    .muted{color:#666;font-size:12px}
    .pill{display:inline-block;padding:2px 6px;border-radius:999px;background:#eef}
    .topbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:10px 0}
    .pagination{display:flex;gap:6px;align-items:center}
    .status-auto{background:#eef}
    .status-approved{background:#e9fbe9}
    .status-review_needed{background:#fff3cd}
    .status-rejected{background:#fde2e2}
    .nowrap{white-space:nowrap}
    .w-80{width:80px}
    .w-120{width:120px}
    .w-200{width:200px}
    .txt-sm{font-size:12px}
  </style>
</head>
<body>
  <header>
    <h2>Back-office Traductions</h2>
    <span class="muted">Modifier / rechercher vos traductions stockées</span>
  </header>

  <section class="topbar">
  <div class="row">
    <input id="q" class="w-200" placeholder="Recherche texte…" />
    <select id="status" class="w-120">
      <option value="">Statut (tous)</option>
      <option value="auto">auto</option>
      <option value="approved">approved</option>
      <option value="review_needed">review_needed</option>
      <option value="rejected">rejected</option>
    </select>
    <input id="from" class="w-80" placeholder="source (fr)" />
    <input id="to" class="w-80" placeholder="cible (nl)" />
    <input id="page" class="w-200" placeholder="page_path (contient)" />
    <button id="search">Rechercher</button>
  </div>

  <div class="row">
    <span id="modePill" class="pill status-auto">DeepL : …</span>
    <button id="deeplOn">Activer DeepL</button>
    <button id="deeplOff">Désactiver DeepL</button>
  </div>

  <div class="pagination">
    <button id="prev">◀</button>
    <span id="pageInfo" class="muted"></span>
    <button id="next">▶</button>
  </div>
  </section>

  <table id="grid"><thead>
    <tr>
      <th class="nowrap">Langs</th>
      <th>Source</th>
      <th>Traduction</th>
      <th class="nowrap">Statut</th>
      <th>Page</th>
      <th class="nowrap">MAJ</th>
      <th class="nowrap">Actions</th>
    </tr>
  </thead><tbody></tbody></table>

  <template id="rowTpl">
    <tr>
      <td class="nowrap"></td>
      <td></td>
      <td></td>
      <td class="nowrap"></td>
      <td class="txt-sm"></td>
      <td class="txt-sm"></td>
      <td class="nowrap"></td>
    </tr>
  </template>

  <script>
    const qs = new URLSearchParams(location.search);
    const token = qs.get("token") || localStorage.getItem("ADMIN_TOKEN") || "";
    if (token && !qs.get("token")) localStorage.setItem("ADMIN_TOKEN", token);

    let curPage = 1, lastPage = 1, pageSize = 25;

    async function fetchList() {
      const params = new URLSearchParams({
        page: curPage, limit: pageSize,
        q: document.getElementById('q').value.trim(),
        status: document.getElementById('status').value,
        from: document.getElementById('from').value.trim(),
        to: document.getElementById('to').value.trim(),
        page_path: document.getElementById('page').value.trim()
      });
      const r = await fetch('/admin/api/translations?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (r.status === 401) { alert('Unauthorized (ADMIN_TOKEN manquant ou invalide)'); return; }
      const data = await r.json();
      renderRows(data.items || []);
      curPage = data.page; lastPage = data.lastPage;
      document.getElementById('pageInfo').textContent =
        'Page ' + curPage + ' / ' + lastPage + ' — ' + (data.total||0) + ' résultats';
    }

    function pill(status){
      const cls = status==='approved'?'status-approved'
        : status==='review_needed'?'status-review_needed'
        : status==='rejected'?'status-rejected':'status-auto';
      return '<span class="pill '+cls+'">'+status+'</span>';
    }

    function renderRows(items){
      const tb = document.querySelector('#grid tbody');
      tb.innerHTML = '';
      for(const it of items){
        const tr = document.getElementById('rowTpl').content.firstElementChild.cloneNode(true);
        tr.children[0].textContent = it.source_lang + '→' + it.target_lang;
        tr.children[1].textContent = it.source_text;
        const tdTrad = tr.children[2];
        const ta = document.createElement('textarea');
        ta.value = it.translated_text || '';
        ta.style.width = '100%'; ta.rows = 3;
        tdTrad.appendChild(ta);

        tr.children[3].innerHTML = pill(it.status);
        tr.children[4].textContent = it.page_path || '';
        tr.children[5].textContent = new Date(it.updated_at).toLocaleString();

        const btnSave = document.createElement('button');
        btnSave.textContent = 'Enregistrer';
        btnSave.onclick = async () => {
          const newText = ta.value.trim();
          if (!newText) { alert('Texte vide.'); return; }
          const reviewerEmail = prompt('Votre email (pour l’historique):', '') || 'unknown';
          const reason = prompt('Motif (optionnel):', '') || null;
          const r = await fetch('/admin/api/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ id: it.id, newText, reviewerEmail, reason })
          });
          if (r.ok) { alert('Sauvegardé ✓'); fetchList(); }
          else { const t = await r.text(); alert('Erreur: ' + t); }
        };
        tr.children[6].appendChild(btnSave);
        tb.appendChild(tr);
      }
    }

    document.getElementById('search').onclick = () => { curPage = 1; fetchList(); };
    document.getElementById('prev').onclick = () => { if (curPage>1){curPage--; fetchList();} };
    document.getElementById('next').onclick = () => { if (curPage<lastPage){curPage++; fetchList();} };

    function renderMode(mode) {
      const span = document.getElementById('modePill');
      if (!span) return;
      const on = (mode === 'cache+deepl');
      span.textContent = 'DeepL : ' + (on ? 'ON' : 'OFF');
      span.className = 'pill ' + (on ? 'status-approved' : 'status-rejected');
    }

    async function loadMode() {
      try {
        const r = await fetch('/admin/mode', { headers: { 'Authorization': 'Bearer ' + token }});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        renderMode(data.mode || 'cache-only');
      } catch (e) {
        console.error(e);
        renderMode('cache-only');
      }
    }

    async function setMode(mode) {
      try {
        const r = await fetch('/admin/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ mode })
        });
        if (!r.ok) { const t = await r.text(); alert('Erreur: ' + t); return; }
        const data = await r.json();
        renderMode(data.mode);
      } catch (e) { alert('Erreur: ' + e.message); }
    }

    document.getElementById('deeplOn').onclick  = () => setMode('cache+deepl');
    document.getElementById('deeplOff').onclick = () => setMode('cache-only');

    loadMode();
    fetchList();
  </script>
</body></html>`;

// 2) Servez l’HTML sans template inline
app.get("/admin", requireAdmin, (_req, res) => {
  res.type("html").send(ADMIN_HTML);
});


/* ======================  Utils  ====================== */
const normalizeSource = (str = "") =>
  str.normalize("NFKD").toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const makeChecksum = ({ sourceNorm, targetLang, selectorHash = "" }) =>
  crypto.createHash("sha256")
    .update(`${sourceNorm}::${targetLang}::${selectorHash}`)
    .digest("hex");

/* ======================  DB  ====================== */
const makeInternalConn = () => {
  const h = process.env.DB_HOST;
  const p = process.env.DB_PORT || "5432";
  const d = process.env.DB_NAME;
  const u = process.env.DB_USER;
  const pw = process.env.DB_PASSWORD;
  if (h && d && u && pw) {
    return `postgres://${encodeURIComponent(u)}:${encodeURIComponent(pw)}@${h}:${p}/${d}`;
  }
  return null;
};

const connectionString =
  process.env.POOL_DATABASE_URL || process.env.DATABASE_URL || makeInternalConn();

if (!connectionString) {
  console.error("❌ No DB connection info (POOL_DATABASE_URL / DATABASE_URL / DB_*).");
  process.exit(1);
}

const pool = new Pool({ connectionString });

/* ======================  Config mode (DB)  ====================== */
async function getMode() {
  const { rows } = await pool.query(
    `SELECT value FROM public.app_config WHERE key='mode' LIMIT 1`
  );
  return (rows[0]?.value || process.env.TRANSLATION_MODE || 'cache-only').trim();
}
async function setMode(v) {
  await pool.query(
    `INSERT INTO public.app_config(key,value) VALUES('mode',$1)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [v]
  );
}
function countChars(s=""){ return [...(s||"")].length; } // gère UTF-16 correctement

async function bumpUsage({
  day = new Date().toISOString().slice(0,10),
  projectId,
  sourceLang,
  targetLang,
  fromCache,             // true/false
  provider = fromCache ? 'none' : 'deepl',
  chars = 0
}){
  await pool.query(`
    INSERT INTO public.usage_stats(day, project_id, source_lang, target_lang, from_cache, provider, chars_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (day, project_id, source_lang, target_lang, from_cache, provider)
    DO UPDATE SET chars_count = public.usage_stats.chars_count + EXCLUDED.chars_count
  `, [day, projectId, sourceLang, targetLang, !!fromCache, provider, Math.max(0, chars|0)]);
}


/* ======================  DeepL  ====================== */
async function translateWithDeepL({ text, sourceLang, targetLang }) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error('DEEPL_API_KEY missing');

  const body = new URLSearchParams({
    text,
    source_lang: sourceLang.toUpperCase(),
    target_lang: targetLang.toUpperCase(),
  });

  const r = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!r.ok) throw new Error(`DeepL ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.translations?.[0]?.text || '';
}

/* ======================  Routes publiques  ====================== */
app.get("/health", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.send("OK"));
app.get("/", (_req, res) => res.send("OK"));


app.get("/dbping", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS now");
    res.json({ ok: true, now: rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/cache/find", async (req, res) => {
  try {
    const {
      projectId = process.env.PROJECT_ID,
      sourceLang, targetLang, sourceText,
      selectorHash = "",
    } = req.body || {};

    if (!projectId || !sourceLang || !targetLang || !sourceText) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({ sourceNorm, targetLang, selectorHash });

    const { rows } = await pool.query(
      `SELECT id, source_text, translated_text, status
         FROM translations
        WHERE project_id=$1 AND source_lang=$2 AND target_lang=$3
          AND checksum = decode($4,'hex')
        LIMIT 1`,
      [projectId, sourceLang, targetLang, sumHex]
    );

    res.json({ hit: rows[0] || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/cache/upsert", async (req, res) => {
  try {
    const {
      projectId = process.env.PROJECT_ID,
      sourceLang, targetLang, sourceText, translatedText,
      contextUrl = null, pagePath = null, selectorHash = null,
    } = req.body || {};

    if (!projectId || !sourceLang || !targetLang || !sourceText || !translatedText) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({ sourceNorm, targetLang, selectorHash: selectorHash || "" });

    const { rows } = await pool.query(
      `INSERT INTO translations(
         project_id, source_lang, target_lang,
         source_text, source_norm, translated_text,
         context_url, page_path, selector_hash,
         checksum, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, decode($10,'hex'), 'auto')
       ON CONFLICT (project_id, source_lang, target_lang, checksum)
       DO UPDATE SET
         translated_text = CASE
           WHEN NOT translations.is_locked THEN EXCLUDED.translated_text
           ELSE translations.translated_text
         END,
         context_url   = COALESCE(EXCLUDED.context_url, translations.context_url),
         page_path     = COALESCE(EXCLUDED.page_path, translations.page_path),
         selector_hash = COALESCE(EXCLUDED.selector_hash, translations.selector_hash),
         updated_at = now()
       RETURNING *;`,
      [projectId, sourceLang, targetLang, sourceText, sourceNorm, translatedText,
       contextUrl, pagePath, selectorHash, sumHex]
    );

    res.json({ saved: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/translate', async (req, res) => {
  try {
    const {
      projectId = process.env.PROJECT_ID,
      sourceLang, targetLang, sourceText,
      contextUrl = null, pagePath = null, selectorHash = null
    } = req.body || {};

    if (!projectId || !sourceLang || !targetLang || !sourceText) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // 1) cache
    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({ sourceNorm, targetLang, selectorHash: selectorHash || '' });

    const hit = await pool.query(
      `SELECT translated_text FROM translations
        WHERE project_id=$1 AND source_lang=$2 AND target_lang=$3
          AND checksum=decode($4,'hex')
        LIMIT 1`,
      [projectId, sourceLang, targetLang, sumHex]
    );
    // -- après le SELECT hit cache :
if (hit.rows[0]?.translated_text) {
  // compteur: cache hit
  await bumpUsage({
    projectId, sourceLang, targetLang,
    fromCache: true,
    provider: 'none',
    chars: countChars(sourceText) // on compte la demande initiale
  });
  return res.json({ from: 'cache', text: hit.rows[0].translated_text });
}

// -- avant/après l'appel DeepL :
const mode = await getMode();
if (mode !== 'cache+deepl') {
  // compteur: miss (cache-only)
  await bumpUsage({
    projectId, sourceLang, targetLang,
    fromCache: false,
    provider: 'none',
    chars: countChars(sourceText)
  });
  return res.status(404).json({ error: 'miss', note: 'cache-only mode' });
}

const translatedText = await translateWithDeepL({ text: sourceText, sourceLang, targetLang });

// compteur: provider DeepL
await bumpUsage({
  projectId, sourceLang, targetLang,
  fromCache: false,
  provider: 'deepl',
  chars: countChars(sourceText) // on facture côté provider sur l'entrée
});


    // 3) upsert (sauvegarde)
    const { rows } = await pool.query(
      `INSERT INTO translations(
         project_id, source_lang, target_lang,
         source_text, source_norm, translated_text,
         context_url, page_path, selector_hash, checksum, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),'auto')
       ON CONFLICT (project_id,source_lang,target_lang,checksum) DO UPDATE
         SET translated_text = COALESCE(EXCLUDED.translated_text, translations.translated_text),
             context_url     = COALESCE(EXCLUDED.context_url,     translations.context_url),
             page_path       = COALESCE(EXCLUDED.page_path,       translations.page_path),
             selector_hash   = COALESCE(EXCLUDED.selector_hash,   translations.selector_hash),
             updated_at = now()
       RETURNING translated_text`,
      [projectId, sourceLang, targetLang, sourceText, sourceNorm, translatedText,
       contextUrl, pagePath, selectorHash, sumHex]
    );

    res.json({ from: 'deepl', text: rows[0].translated_text });
  } catch (e) {
    console.error('translate error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ======================  Routes Admin API  ====================== */
// Lire l’état du mode DeepL
app.get("/admin/mode", requireAdmin, async (_req, res) => {
  try {
    const mode = await getMode(); // 'cache-only' | 'cache+deepl'
    res.json({ mode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Changer l’état du mode DeepL
app.post("/admin/mode", requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!['cache-only', 'cache+deepl'].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'cache-only' or 'cache+deepl'" });
    }
    await setMode(mode);
    res.json({ mode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Liste paginée + filtres
app.get("/admin/api/translations", requireAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? "25", 10)));
    const offset = (page - 1) * limit;

    const q         = (req.query.q ?? "").toString().trim();
    const status    = (req.query.status ?? "").toString().trim();
    const from      = (req.query.from ?? "").toString().trim();
    const to        = (req.query.to ?? "").toString().trim();
    const page_path = (req.query.page_path ?? "").toString().trim();

    const where = ["1=1"];
    const params = [];
    let i = 1;

    if (q)        { where.push(`(source_text ILIKE $${i} OR translated_text ILIKE $${i})`); params.push(`%${q}%`); i++; }
    if (status)   { where.push(`status = $${i}`); params.push(status); i++; }
    if (from)     { where.push(`source_lang = $${i}`); params.push(from); i++; }
    if (to)       { where.push(`target_lang = $${i}`); params.push(to); i++; }
    if (page_path){ where.push(`page_path ILIKE $${i}`); params.push(`%${page_path}%`); i++; }

    const whereSQL = where.join(" AND ");

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM translations WHERE ${whereSQL}`, params
    );
    const total = totalRows[0]?.total ?? 0;

    const { rows: items } = await pool.query(
      `SELECT id, source_lang, target_lang, source_text, translated_text, status, page_path, updated_at
         FROM translations
        WHERE ${whereSQL}
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const lastPage = Math.max(1, Math.ceil(total / limit));
    res.json({ page, lastPage, total, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Edition d’une traduction
app.post("/admin/api/edit", requireAdmin, async (req, res) => {
  try {
    const { id, newText, reviewerEmail = null, reason = null } = req.body || {};
    if (!id || !newText) return res.status(400).json({ error: "Missing id or newText" });

    const { rowCount } = await pool.query(
      `UPDATE translations
          SET translated_text = $1,
              status = COALESCE(NULLIF(status,''),'approved'),
              updated_at = now()
        WHERE id = $2`,
      [newText, id]
    );

    // (optionnel) journalisation dans une table d’audit
    // await pool.query(
    //   `INSERT INTO translations_audit(translation_id, reviewer_email, reason, new_text)
    //    VALUES($1,$2,$3,$4)`,
    //   [id, reviewerEmail, reason, newText]
    // );

    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});
// --- Debug: version du build Render
app.get("/__version", (_req,res)=>{
  res.json({
    commit: process.env.RENDER_GIT_COMMIT || null,
    branch: process.env.RENDER_GIT_BRANCH || null,
    builtAt: process.env.RENDER_BUILD_TIME || null
  });
});

// --- Debug: lister toutes les routes
function __collectRoutes(app){
  const routes=[];
  app._router?.stack?.forEach((m)=>{
    if(m.route){
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      routes.push({ path:m.route.path, methods });
    }
  });
  return routes;
}
app.get("/__routes", (_req,res)=> res.json(__collectRoutes(app).sort((a,b)=>a.path.localeCompare(b.path))));

// Log dans les logs Render au démarrage
console.log("Routes:", __collectRoutes(app).map(r=>`${r.methods} ${r.path}`).sort().join(" | "));

// GET /admin/stats?from=2025-10-01&to=2025-10-31&projectId=... (tous par défaut)
// Ajoute coût estimé via env: DEEPL_COST_PER_MILLION_EUR (ex: "20.0")
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const from = (req.query.from || "").toString().trim();
    const to   = (req.query.to   || "").toString().trim();
    const projectId = (req.query.projectId || "").toString().trim();

    const where = ["1=1"];
    const params = [];
    let i = 1;

    if (from) { where.push(`day >= $${i++}`); params.push(from); }
    if (to)   { where.push(`day <= $${i++}`); params.push(to); }
    if (projectId) { where.push(`project_id = $${i++}`); params.push(projectId); }

    const sql = `
      SELECT
        day, project_id, source_lang, target_lang, from_cache, provider,
        SUM(chars_count)::int AS chars
      FROM public.usage_stats
      WHERE ${where.join(" AND ")}
      GROUP BY day, project_id, source_lang, target_lang, from_cache, provider
      ORDER BY day DESC, project_id, source_lang, target_lang
    `;
    const { rows } = await pool.query(sql, params);

    // Totaux utiles
    const totalCharsDeepl = rows
      .filter(r => r.provider === 'deepl')
      .reduce((a,b)=>a + (b.chars|0), 0);

    const pricePerMillion = Number(process.env.DEEPL_COST_PER_MILLION_EUR || "0"); // ex: 20
    const estimatedCostEUR = pricePerMillion > 0
      ? (totalCharsDeepl / 1_000_000) * pricePerMillion
      : 0;

    res.json({
      rows,
      totals: {
        chars_deepl: totalCharsDeepl,
        price_per_million_eur: pricePerMillion,
        estimated_cost_eur: Number(estimatedCostEUR.toFixed(2))
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});



/* ======================  Boot  ====================== */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => console.log(`✅ API up on :${PORT}`));
