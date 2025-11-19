// server.js
import express from "express";
import { Pool } from "pg";
import crypto from "node:crypto";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

// ---- Canonicalization helper: /complete/2574 -> /complete
function canonicalizePath(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw, 'https://dummy.local/');
    return u.pathname.replace(/\/(?:\d+|[0-9a-f]{6,}|[0-9a-f-]{8,})\/?$/i, '');
  } catch {
    return String(raw).replace(/\/(?:\d+|[0-9a-f]{6,}|[0-9a-f-]{8,})\/?$/i, '');
  }
}

// ---- Language detection (lazy, optional) using franc-min if installed
let __franc = null;
async function loadFranc(){
  if (__franc !== null) return __franc;
  try {
    const mod = await import('franc-min');
    __franc = (mod && (mod.franc || mod.default)) || null;
  } catch {
    __franc = null; // package not installed -> detection disabled
  }
  return __franc;
}
const ISO3_TO_ISO2 = { fra:'fr', nld:'nl', eng:'en', spa:'es', deu:'de', ita:'it', por:'pt' };
async function detectLang2(text){
  const t=(text||'').toString().trim();
  if (t.length < 8) return null;
  const franc = await loadFranc();
  if (!franc) return null;
  const code3 = franc(t, { minLength: 8 });
  return ISO3_TO_ISO2[code3] || null;
}

// ---- Target language allow-list
const ALLOWED_TARGETS = new Set(['nl','en','es','de','it','pt','fr']);

/* ========== CORS ========== */
const allowList = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const localOK = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = localOK.some(rx => rx.test(origin)) || allowList.includes(origin);
    cb(ok ? null : new Error("CORS blocked"), ok);
  },
  credentials: false
};
// Bypass CORS pour /admin
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  return cors(corsOptions)(req, res, next);
});

/* ========== Auth publique (hors /admin) avec whitelist health ========== */
const API_TOKEN = process.env.API_TOKEN;
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  if (["/health", "/healthz", "/"].includes(req.path)) return next();
  if (!API_TOKEN) return next();
  const header = req.get("Authorization") || "";
  if (header === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

/* ========== Auth admin ========== */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(500).json({ error: "ADMIN_TOKEN not set" });
  const header = req.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.query.token || req.body?.token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized (admin)" });
}

/* ========== Back-office HTML ========== */
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
      <span id="modePill" class="pill status-auto">IA (OpenAI) : …</span>
      <button id="deeplOn">Activer IA</button>
      <button id="deeplOff">Désactiver IA</button>
      <button id="flushBtn">Vider le cache</button>
      <span id="noncePill" class="pill" style="background:#eef">nonce: …</span>

      <span id="statsPill" class="pill" style="background:#eef">—</span>
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

      for (const it of items) {
        const tr = document
          .getElementById('rowTpl')
          .content
          .firstElementChild
          .cloneNode(true);

        // Colonne 0 : Langs + badge tpl
        tr.children[0].textContent = it.source_lang + '→' + it.target_lang;
        if (it.is_template) {
          const b = document.createElement('span');
          b.className = 'pill status-review_needed';
          b.style.marginLeft = '6px';
          b.textContent = 'tpl';
          tr.children[0].appendChild(b);
        }

        // Colonne 1 : Source (textarea + éventuel pattern_key)
        const tdSource = tr.children[1];
        const srcInput = document.createElement('textarea');
        srcInput.value = it.source_text || '';
        srcInput.rows = 2;
        srcInput.style.width = '100%';
        tdSource.appendChild(srcInput);

        if (it.is_template && it.pattern_key) {
          const small = document.createElement('div');
          small.className = 'muted txt-sm';
          small.textContent = 'pattern: ' + it.pattern_key;
          tdSource.appendChild(small);
        }

        // Colonne 2 : Traduction (textarea)
        const tdTrad = tr.children[2];
        const ta = document.createElement('textarea');
        ta.value = it.translated_text || '';
        ta.rows = 3;
        ta.style.width = '100%';
        tdTrad.appendChild(ta);

        // Colonne 3 : Statut (avec pill)
        tr.children[3].innerHTML = pill(it.status || 'auto');

        // Colonne 4 : Page
        tr.children[4].textContent = it.page_path || '';

        // Colonne 5 : Date MAJ
        tr.children[5].textContent = it.updated_at
          ? new Date(it.updated_at).toLocaleString()
          : '';

        // Colonne 6 : Actions (Enregistrer / Supprimer)
        const tdActions = tr.children[6];

        const btnSave = document.createElement('button');
        btnSave.textContent = 'Enregistrer';
        btnSave.addEventListener('click', async () => {
          const newText   = ta.value.trim();
          const newSource = srcInput.value.trim();
          if (!newText) {
            alert('Texte de traduction vide.');
            return;
          }
          btnSave.disabled = true;
          btnSave.textContent = '…';

          try {
            const r = await fetch('/admin/api/edit', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
              },
              body: JSON.stringify({
                id: it.id,
                newText,
                newSource
              })
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            alert('Sauvegardé.');
            await fetchList(); // rechargement de la page courante
          } catch (e) {
            console.error(e);
            alert('Erreur lors de la sauvegarde.');
          } finally {
            btnSave.disabled = false;
            btnSave.textContent = 'Enregistrer';
          }
        });

        const btnDel = document.createElement('button');
        btnDel.textContent = 'Supprimer';
        btnDel.style.marginLeft = '6px';
        btnDel.addEventListener('click', async () => {
          if (!confirm('Supprimer cette entrée ?')) return;
          btnDel.disabled = true;
          btnDel.textContent = '…';
          try {
            const r = await fetch('/admin/api/delete', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
              },
              body: JSON.stringify({ id: it.id })
            });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            await fetchList();
          } catch (e) {
            console.error(e);
            alert('Erreur lors de la suppression.');
          }
        });

        tdActions.appendChild(btnSave);
        tdActions.appendChild(btnDel);

        tb.appendChild(tr);
      }
    }


    function renderMode(mode) {
      const span = document.getElementById('modePill');
      if (!span) return;
      const on = (mode === 'cache+deepl');
      span.textContent = 'IA (OpenAI) : ' + (on ? 'ON' : 'OFF');
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

    async function loadStats(){
      try{
        const r = await fetch('/admin/stats', { headers: { 'Authorization':'Bearer '+token } });
        if(!r.ok) throw new Error('HTTP '+r.status);
        const js = await r.json();
        const today = js.today || {};
        const calls = Number(today.deepl_calls || 0);
        const chars = Number(today.deepl_chars || 0);
        const hits  = Number(today.cache_hits  || 0);
        const miss  = Number(today.cache_miss  || 0);
        const pill = document.getElementById('statsPill');
        pill.textContent =
          "Aujourd'hui — IA (OpenAI): " + calls +
          " req / " + chars.toLocaleString() +
          " car. · Cache: " + hits +
          " hit / " + miss + " miss";
      }catch(e){
        console.error(e);
        const pill = document.getElementById('statsPill');
        if(pill) pill.textContent = 'Stats indisponibles';
      }
    }

    document.getElementById('search').onclick = () => { curPage = 1; fetchList(); };
    document.getElementById('prev').onclick = () => { if (curPage>1){curPage--; fetchList();} };
    document.getElementById('next').onclick = () => { if (curPage<lastPage){curPage++; fetchList();} };

    document.getElementById('deeplOn').onclick  = () => setMode('cache+deepl');
    document.getElementById('deeplOff').onclick = () => setMode('cache-only');
    document.getElementById('flushBtn').onclick = async () => {
      if (!confirm('Confirmer le vidage du cache front ?')) return;
      try{
        const r = await fetch('/admin/api/flush-cache', {
          method: 'POST',
          headers: { 'Authorization':'Bearer '+token }
        });
        if(!r.ok){ const t = await r.text(); alert('Erreur: '+t); return; }
        const js = await r.json();
        alert('Cache vidé ✓ (nonce = '+js.nonce+')');
        loadNonce();
      }catch(e){
        alert('Erreur: '+e.message);
      }
    };

    async function loadNonce(){
      try{
        const r = await fetch('/admin/api/cache-nonce', {
          headers: { 'Authorization':'Bearer '+token }
        });
        if(!r.ok) throw new Error('HTTP '+r.status);
        const js = await r.json();
        const el = document.getElementById('noncePill');
        if (el) el.textContent = 'nonce: ' + js.nonce;
      }catch(e){
        const el = document.getElementById('noncePill');
        if (el) el.textContent = 'nonce: (indispo)';
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

    loadMode();
    loadStats();
    fetchList();
    loadNonce();

  </script>
</body></html>`;

// Servez l’HTML
app.get("/admin", requireAdmin, (_req, res) => {
  res.type("html").send(ADMIN_HTML);
});

/* ========== Utils ========== */
const normalizeSource = (str = "") =>
  str.normalize("NFKD").toLowerCase()
    .replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

const makeChecksum = ({ sourceNorm, targetLang, selectorHash = "" }) =>
  crypto.createHash("sha256")
    .update(`${sourceNorm}::${targetLang}::${selectorHash}`).digest("hex");

// --- GABARITS: masquage chiffres / montants / unités ---
function maskNumbersAndUnits(text="") {
  const map = [];
  let i = 0;
  let out = String(text);

  // Montants/valeurs (€, kg, h, cm, mm, %, etc.)
  const TOKEN = () => `__TOK${i++}__`;
  out = out.replace(/([\+\-]?\s*)?(\d[\d\s.,]*)(\s*(?:€|eur|£|gbp|\$|usd|chf|¥|jpy|kg|g|cm|mm|m|h|%))\b/gi, (m) => {
    const k = TOKEN(); map.push([k, m]); return k;
  });

  // Nombres "nus"
  out = out.replace(/\d[\d\s.,-]*/g, (m) => {
    const k = TOKEN(); map.push([k, m]); return k;
  });

  return { out, map };
}
function unmaskTokens(text="", map=[]) {
  let res = String(text);
  for (const [k,v] of map) res = res.replace(k, v);
  return res;
}
function buildPatternKey(text="") {
  let out = String(text);
  out = out.replace(/([\+\-]?\s*)?(\d[\d\s.,]*)(\s*(?:€|eur|£|gbp|\$|usd|chf|¥|jpy|kg|g|cm|mm|m|h|%))\b/gi, () => "__NUM__");
  out = out.replace(/\d[\d\s.,-]*/g, () => "__NUM__");
  return out.replace(/\s+/g, ' ').trim();
}

/* ========== DB ========== */
const makeInternalConn = () => {
  const h = process.env.DB_HOST; const p = process.env.DB_PORT || "5432";
  const d = process.env.DB_NAME; const u = process.env.DB_USER; const pw = process.env.DB_PASSWORD;
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

/* ========== Config mode (DB) ========== */
async function getMode() {
  const { rows } = await pool.query(
    `SELECT value FROM public.app_config WHERE key='mode' LIMIT 1`
  );
  return (rows[0]?.value || process.env.TRANSLATION_MODE || 'cache-only').trim();
}
async function setMode(v) {
  await pool.query(
    `INSERT INTO public.app_config(key,value) VALUES('mode',$1)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]
  );
}

/* ========== Usage metrics ========== */
async function logUsage({ projectId, sourceLang, targetLang, fromCache, provider, chars }) {
  const day = new Date().toISOString().slice(0,10);
  const _chars = Math.max(0, (chars|0));
  await pool.query(`
    INSERT INTO public.usage_stats(
      day, project_id, source_lang, target_lang, from_cache, provider,
      chars_count, calls_count, created_at, updated_at
    )
    VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, 1, now(), now())
    ON CONFLICT (day, project_id, source_lang, target_lang, from_cache, provider)
    DO UPDATE SET
      chars_count = public.usage_stats.chars_count + EXCLUDED.chars_count,
      calls_count = public.usage_stats.calls_count + 1,
      updated_at  = now()
  `, [projectId, sourceLang, targetLang, !!fromCache, provider, _chars]);
}

/* ========== OpenAI (ChatGPT) ========== */
async function translateWithOpenAI({ text, sourceLang, targetLang }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const systemPrompt = `
Tu es un moteur de traduction professionnel.
- Tu traduis du ${sourceLang} vers le ${targetLang}.
- Tu ne rajoutes pas d'information.
- Tu ne reformules pas pour faire "plus joli".
- Tu conserves les balises HTML éventuelles.
- Tu conserves exactement les variables entre {accolades} ou %PLACEHOLDER%.
- Tu conserves les nombres, unités et symboles tels quels.
Réponds uniquement avec le texte traduit, sans guillemets ni commentaire.
`.trim();

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text }
    ]
  });

  const out = response.choices?.[0]?.message?.content || "";
  return out.trim();
}

/* ========== Routes publiques ========== */
app.get("/health", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.send("OK"));
app.get("/", (_req,res)=>res.send("OK"));

app.get("/dbping", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS now");
    res.json({ ok: true, now: rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Cache helper endpoints (inchangés)
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
    if ((sourceLang || "").toUpperCase() === (targetLang || "").toUpperCase()) {
      return res.json({ from: "bypass", text: sourceText });
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

    let hit = rows[0] || null;

    if (!hit) {
      const { rows: rows2 } = await pool.query(
        `SELECT id, source_text, translated_text, status
         FROM translations
         WHERE project_id=$1 AND source_lang=$2 AND target_lang=$3
           AND source_norm=$4
         ORDER BY updated_at DESC
         LIMIT 1`,
        [projectId, sourceLang, targetLang, sourceNorm]
      );
      hit = rows2[0] || null;
    }
    res.json({ hit });
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
       ON CONFLICT (project_id, source_lang, target_lang, source_norm)
       DO UPDATE SET
         translated_text = CASE
           WHEN NOT translations.is_locked THEN EXCLUDED.translated_text
           ELSE translations.translated_text
         END,
         context_url   = COALESCE(EXCLUDED.context_url, translations.context_url),
         page_path     = COALESCE(EXCLUDED.page_path, translations.page_path),
         selector_hash = COALESCE(EXCLUDED.selector_hash, translations.selector_hash),
         checksum      = EXCLUDED.checksum,
         updated_at    = now()
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

// ========== Orchestrateur: /translate ==========
app.post('/translate', async (req, res) => {
  try {
    const {
      projectId = process.env.PROJECT_ID,
      sourceLang, targetLang, sourceText,
      contextUrl = null, pagePath = null, selectorHash = null
    } = req.body || {};

        // --- Ne pas traduire les adresses, emails, téléphones, noms/sociétés très courts
    const txt = (sourceText || "").trim();

    // Adresse FR/ES typique : numéro + mot clé rue/avenue/calle… (+ souvent un CP)
    const ADDRESS_RX = /\b\d{1,5}\s+(rue|avenue|av\.|bd|boulevard|impasse|all[ée]e?|place|plaza|calle|carrer|via|strasse|straße|straat|road|rd\.|street|st\.|lane|ln\.|way)\b/i;
    const POSTAL_CODE_RX = /\b\d{4,5}\b/;  // 75010, 08015, etc.

    // Email, URL, téléphone
    const EMAIL_OR_URL_RX = /@|https?:\/\//i;
    const PHONE_RX        = /(\+?\d[\d\s().-]{5,})/;

    // Nom/prénom/société très courts (1 ou 2 mots, sans chiffres)
    const SHORT_NAME_RX = /^[A-ZÉÈÀÂÇ][^\d]{1,40}$/i;

    // Heuristique globale : si ça ressemble clairement à une adresse OU à un contact, on ne traduit pas
    const looksLikeAddress =
      (ADDRESS_RX.test(txt) && POSTAL_CODE_RX.test(txt)) ||
      (txt.split(",").length - 1) >= 2; // plusieurs virgules = souvent adresse

    if (
  looksLikeAddress ||
  EMAIL_OR_URL_RX.test(txt) ||
  PHONE_RX.test(txt)
) {
  return res.json({ from: 'bypass', text: sourceText });
}



    // Detection + canonical + target whitelist
    const detected = await detectLang2(sourceText);

// On respecte d'abord ce que le front envoie (FR), et on n'utilise la détection
// qu'en secours si jamais sourceLang est vide.
const effectiveSourceLang = (sourceLang || detected || 'fr').toUpperCase();

    if (!ALLOWED_TARGETS.has((targetLang||'').toLowerCase())) {
      return res.status(400).json({ error: 'Unsupported targetLang' });
    }
    const pageCanonical = canonicalizePath(pagePath);

    if (!projectId || !effectiveSourceLang || !targetLang || !sourceText) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // 0.b) Bypass pour les dimensions du type "55 x 85", "60x90 mm", etc.
const DIM_RX = /^\s*\d[\d\s.,]*\s*[x×]\s*\d[\d\s.,]*\s*(mm|cm|m)?\s*\.?\s*$/i;

if (DIM_RX.test(sourceText || '')) {
  return res.json({ from: 'bypass', text: sourceText });
}



    // --- <<< TEMPLATE: clé gabarit prioritaire >>>
    const sourceNorm = normalizeSource(sourceText);
    const patternKey = buildPatternKey(sourceText);

    // 1) Lookup GABARIT (is_template=true, pattern_key)
    const { rows: tplRows } = await pool.query(
      `SELECT translated_text
         FROM translations
        WHERE project_id=$1 AND source_lang=$2 AND target_lang=$3
          AND is_template=true
          AND pattern_key=$4
        ORDER BY updated_at DESC
        LIMIT 1`,
      [projectId, effectiveSourceLang, targetLang, patternKey]
    );
    const templateHit = tplRows[0]?.translated_text || null;
    if (templateHit) {
      const { map } = maskNumbersAndUnits(sourceText);
      const out = unmaskTokens(templateHit, map);
      try {
        await logUsage({ provider:'cache', fromCache:true,
          chars:(sourceText||'').length, projectId,
          sourceLang: effectiveSourceLang, targetLang });
      } catch {}
      return res.json({ from:'cache-template', text: out });
    }

    // 1.b) Fallback cache “ancien” (checksum + source_norm)
        const sumHex = makeChecksum({
      sourceNorm,
      targetLang,
      selectorHash: selectorHash || ''
    });
    let cachedText = null;

    // On ne prend JAMAIS les gabarits (is_template=true) dans le cache
    const hit = await pool.query(
      `SELECT translated_text
         FROM translations
        WHERE project_id=$1
          AND source_lang=$2
          AND target_lang=$3
          AND checksum = decode($4,'hex')
          AND (is_template IS NULL OR is_template = false)
        LIMIT 1`,
      [projectId, effectiveSourceLang, targetLang, sumHex]
    );
    cachedText = hit.rows[0]?.translated_text || null;

    if (!cachedText) {
      const alt = await pool.query(
        `SELECT translated_text
           FROM translations
          WHERE project_id=$1
            AND source_lang=$2
            AND target_lang=$3
            AND source_norm=$4
            AND (is_template IS NULL OR is_template = false)
          ORDER BY updated_at DESC
          LIMIT 1`,
        [projectId, effectiveSourceLang, targetLang, sourceNorm]
      );
      cachedText = alt.rows[0]?.translated_text || null;
    }

    if (cachedText) {
      try {
        await logUsage({
          provider: 'cache',
          fromCache: true,
          chars: (sourceText || '').length,
          projectId,
          sourceLang: effectiveSourceLang,
          targetLang
        });
      } catch {}

      return res.json({ from: 'cache', text: cachedText });
    }



    // 2) OpenAI uniquement si autorisé (mode = cache+deepl, réutilisé pour IA)
    // 2) Appel provider externe uniquement si autorisé
const currentMode = (await getMode() || '').toLowerCase();

// tout ce qui commence par 'cache+' active le moteur externe
const providerEnabled = currentMode.startsWith('cache+');

if (!providerEnabled) {
  try {
    await logUsage({ provider:'none', fromCache:false, chars:0,
      projectId, sourceLang: effectiveSourceLang, targetLang });
  } catch {}
  return res.status(404).json({ error: 'miss', note: currentMode || 'cache-only mode' });
}


    // 3) APPEL OpenAI sur TEXTE MASQUÉ (gabarit)
    const { out: masked, map } = maskNumbersAndUnits(sourceText);
    const aiMasked = await translateWithOpenAI({
      text: masked,
      sourceLang: effectiveSourceLang,
      targetLang
    });

    try {
      await logUsage({ provider:'openai', fromCache:false,
        chars:(sourceText||'').length, projectId,
        sourceLang: effectiveSourceLang, targetLang });
    } catch {}

    // 4) Sauvegarde gabarit (is_template=true, pattern_key)
    const upsertTpl = await pool.query(
      `INSERT INTO translations(
         project_id, source_lang, target_lang,
         source_text, source_norm, translated_text,
         context_url, page_path, selector_hash, checksum, status,
         is_template, pattern_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),'auto', true, $11)
       ON CONFLICT (project_id, source_lang, target_lang, source_norm)
       DO UPDATE SET
         translated_text = COALESCE(EXCLUDED.translated_text, translations.translated_text),
         context_url     = COALESCE(EXCLUDED.context_url,     translations.context_url),
         page_path       = COALESCE(EXCLUDED.page_path,       translations.page_path),
         selector_hash   = COALESCE(EXCLUDED.selector_hash,   translations.selector_hash),
         checksum        = EXCLUDED.checksum,
         is_template     = true,
         pattern_key     = EXCLUDED.pattern_key,
         updated_at      = now()
       RETURNING translated_text`,
        [
    projectId,
    effectiveSourceLang,
    targetLang,
    sourceText,                  // texte FR original
    normalizeSource(sourceText), // normalisation du texte FR
    aiMasked,                    // traduction masquée (avec TOK)
    contextUrl,
    pageCanonical,
    selectorHash,
    sumHex,
    patternKey
  ]
);

    const templateText = upsertTpl.rows[0]?.translated_text || aiMasked;
    const finalOut = unmaskTokens(templateText, map);
    return res.json({ from:'openai-template', text: finalOut });

  } catch (e) {
    console.error('translate error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ========== Admin API ========== */
app.get("/admin/mode", requireAdmin, async (_req, res) => {
  try {
    const mode = await getMode();
    res.json({ mode });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

const ALLOWED_MODES = ['cache-only', 'cache+deepl', 'cache+openai'];

app.post("/admin/mode", requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!ALLOWED_MODES.includes(mode)) {
      return res.status(400).json({ error: "mode must be one of: " + ALLOWED_MODES.join(', ') });
    }
    await setMode(mode);
    res.json({ mode });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});


// Stats (agrège usage_stats)
app.get("/admin/stats", requireAdmin, async (_req, res) => {
  const { rows: todayRows } = await pool.query(
    `SELECT
        SUM( (provider='openai')::int )                               AS deepl_calls,
        SUM( CASE WHEN provider='openai' THEN chars_count ELSE 0 END ) AS deepl_chars,
        SUM( (from_cache=true)::int )                                AS cache_hits,
        SUM( (from_cache=false AND provider<>'openai')::int )        AS cache_miss
     FROM public.usage_stats
     WHERE day = CURRENT_DATE`
  );
  const today = todayRows[0] || { deepl_calls:0, deepl_chars:0, cache_hits:0, cache_miss:0 };
  res.json({ today });
});

// Liste paginée
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

    const where = ["1=1"]; const params = []; let i = 1;
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
      `SELECT id, source_lang, target_lang,
       source_text, translated_text, status,
       page_path, updated_at,
       is_template, pattern_key
  FROM translations
 WHERE ${whereSQL}
 ORDER BY updated_at DESC
 LIMIT ${limit} OFFSET ${offset}
`,
      params
    );

    const lastPage = Math.max(1, Math.ceil(total / limit));
    res.json({ page, lastPage, total, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Edition
app.post("/admin/api/edit", requireAdmin, async (req, res) => {
  try {
    const { id, newText, newSource } = req.body || {};
    if (!id || !newText) {
      return res.status(400).json({ error: "Missing id or newText" });
    }

    // On ne touche à source_text / source_norm que si newSource est fourni
    const src = (newSource && newSource.trim()) || null;

    const { rowCount } = await pool.query(
      `UPDATE translations
          SET source_text    = COALESCE($1, source_text),
              source_norm    = CASE WHEN $1 IS NOT NULL
                                   THEN $2
                                   ELSE source_norm
                              END,
              translated_text = $3,
              status         = COALESCE(NULLIF(status,''),'approved'),
              updated_at     = now()
        WHERE id = $4`,
      [
        src,
        src ? normalizeSource(src) : null,
        newText,
        id
      ]
    );

    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/api/delete", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing id" });

    // D'abord les révisions (FK)
    try {
      await pool.query(
        "DELETE FROM translation_revisions WHERE translation_id = $1",
        [id]
      );
    } catch (e) {
      console.warn("Erreur delete translation_revisions", e.message);
    }

    const { rowCount } = await pool.query(
      "DELETE FROM translations WHERE id = $1",
      [id]
    );

    if (!rowCount) return res.status(404).json({ error: "Not found" });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});



// === Front-cache invalidation (nonce) ===
let CACHE_NONCE = 1;
app.get("/cache-nonce", (_req, res) => { res.json({ nonce: CACHE_NONCE }); });
app.get("/admin/api/cache-nonce", requireAdmin, (_req, res) => { res.json({ nonce: CACHE_NONCE }); });
app.post("/admin/api/flush-cache", requireAdmin, (_req, res) => { CACHE_NONCE++; res.json({ ok: true, nonce: CACHE_NONCE }); });

/* ========== Boot ========== */
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`✅ API up on :${PORT}`));





