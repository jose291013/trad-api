// server.js
import express from "express";
import { Pool } from "pg";
import crypto from "node:crypto";

const app = express();
app.use(express.json());
// --- CORS (si tu appelles l'API depuis un navigateur) ---
import cors from "cors";

// ALLOWED_ORIGINS (ENV) : "https://decoration.ams.v6.pressero.com,https://autre-domaine.fr"
const allowList = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// regex locales autorisées pour les tests
const localOK = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];

const corsOptions = {
  origin: (origin, cb) => {
    // Requêtes serveur (Postman/curl) : pas d'Origin -> OK
    if (!origin) return cb(null, true);
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



// --- Auth simple par jeton ---
// --- Auth simple par jeton (API publique) ---
const API_TOKEN = process.env.API_TOKEN;
app.use((req, res, next) => {
  // ➜ Laisse passer tout ce qui commence par /admin :
  if (req.path.startsWith("/admin")) return next();

  if (!API_TOKEN) return next();
  const header = req.get("Authorization") || ""; // ex: "Bearer abc123"
  if (header === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

// --- Admin auth (jeton distinct de l'API publique) ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// accepte Authorization: Bearer <ADMIN_TOKEN> OU ?token=<ADMIN_TOKEN> (pratique pour l’iframe)
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(500).json({ error: "ADMIN_TOKEN not set" });
  const header = req.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.query.token || req.body?.token;
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized (admin)" });
}


// --- Page Back-office (HTML) ---
app.get("/admin", requireAdmin, (_req, res) => {
  res.type("html").send(`<!doctype html>
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

  <!-- NOUVEAU : contrôles DeepL -->
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
      document.getElementById('pageInfo').textContent = 'Page ' + curPage + ' / ' + lastPage + ' — ' + (data.total||0) + ' résultats';
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
        const tdAct = tr.children[6];
        tdAct.appendChild(btnSave);

        tb.appendChild(tr);
      }
    }

    document.getElementById('search').onclick = () => { curPage = 1; fetchList(); };
    document.getElementById('prev').onclick = () => { if (curPage>1){curPage--; fetchList();} };
    document.getElementById('next').onclick = () => { if (curPage<lastPage){curPage++; fetchList();} };
    // --- Pilotage du mode (cache-only / cache+deepl) ---
  function renderMode(mode) {
    const span = document.getElementById('modePill');
    if (!span) return;
    const on = (mode === 'cache+deepl');
    span.textContent = 'DeepL : ' + (on ? 'ON' : 'OFF');
    span.className = 'pill ' + (on ? 'status-approved' : 'status-rejected');
  }

  async function loadMode() {
    try {
      const r = await fetch('/admin/mode', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
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
      if (!r.ok) {
        const t = await r.text();
        alert('Erreur: ' + t);
        return;
      }
      const data = await r.json();
      renderMode(data.mode);
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  }

  // Boutons ON/OFF
  document.getElementById('deeplOn').onclick  = () => setMode('cache+deepl');
  document.getElementById('deeplOff').onclick = () => setMode('cache-only');

  // Charger l’état au démarrage
  loadMode();


    fetchList();
  </script>
</body></html>`);
});





// -------- utils --------
const normalizeSource = (str = "") =>
  str
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const makeChecksum = ({ sourceNorm, targetLang, selectorHash = "" }) =>
  crypto
    .createHash("sha256")
    .update(`${sourceNorm}::${targetLang}::${selectorHash}`)
    .digest("hex");

// -------- DB connection --------
// Construit une URL interne à partir des morceaux fournis par render.yaml
const makeInternalConn = () => {
  const h = process.env.DB_HOST;
  const p = process.env.DB_PORT || "5432";
  const d = process.env.DB_NAME;
  const u = process.env.DB_USER;
  const pw = process.env.DB_PASSWORD;
  if (h && d && u && pw) {
    return `postgres://${encodeURIComponent(u)}:${encodeURIComponent(
      pw
    )}@${h}:${p}/${d}`;
  }
  return null;
};

// Ordre de priorité : PgBouncer -> DATABASE_URL (si tu l'ajoutes) -> interne reconstituée
const connectionString =
  process.env.POOL_DATABASE_URL || process.env.DATABASE_URL || makeInternalConn();

if (!connectionString) {
  console.error(
    "❌ No DB connection info (POOL_DATABASE_URL / DATABASE_URL / DB_*)."
  );
  process.exit(1);
}

const pool = new Pool({ connectionString });

// ---------- Config mode (DB) ----------
async function getMode() {
  const { rows } = await pool.query(`SELECT value FROM public.app_config WHERE key='mode' LIMIT 1`);
  return (rows[0]?.value || process.env.TRANSLATION_MODE || 'cache-only').trim();
}
async function setMode(v) {
  await pool.query(`
    INSERT INTO public.app_config(key,value) VALUES('mode',$1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
  `, [v]);
}

// ---------- Appel DeepL ----------
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


// -------- routes --------
app.get("/health", (_req, res) => res.send("OK"));

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
      sourceLang,
      targetLang,
      sourceText,
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

// --- cache/upsert (garde l’API existante pour renseigner la DB depuis un proxy/snippet) ---
app.post("/cache/upsert", async (req, res) => {
  try {
    const {
      projectId = process.env.PROJECT_ID,
      sourceLang,
      targetLang,
      sourceText,
      translatedText,
      contextUrl = null,
      pagePath = null,
      selectorHash = null,
    } = req.body || {};

    if (!projectId || !sourceLang || !targetLang || !sourceText || !translatedText) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({
      sourceNorm,
      targetLang,
      selectorHash: selectorHash || "",
    });

    const { rows } = await pool.query(
      `
      INSERT INTO translations(
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
      RETURNING *;
      `,
      [
        projectId,
        sourceLang,
        targetLang,
        sourceText,
        sourceNorm,
        translatedText,
        contextUrl,
        pagePath,
        selectorHash,
        sumHex,
      ]
    );

    res.json({ saved: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Orchestrateur: cache -> DeepL (si autorisé) -> upsert ----------
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
    if (hit.rows[0]?.translated_text) {
      return res.json({ from: 'cache', text: hit.rows[0].translated_text });
    }

    // 2) DeepL si autorisé
    const mode = await getMode(); // 'cache-only' | 'cache+deepl'
    if (mode !== 'cache+deepl') {
      return res.status(404).json({ error: 'miss', note: 'cache-only mode' });
    }

    const translatedText = await translateWithDeepL({
      text: sourceText, sourceLang, targetLang
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
const PORT = Number(process.env.PORT) || 10000;

app.listen(PORT, () => console.log(`✅ API up on :${PORT}`));
