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

app.use(cors({
  origin: (origin, cb) => {
    // Requêtes serveur (Postman, curl) : pas d'origine → on laisse passer
    if (!origin) return cb(null, true);
    const ok = localOK.some(rx => rx.test(origin)) || allowList.includes(origin);
    cb(ok ? null : new Error("CORS blocked"), ok);
  },
  credentials: false
}));


// --- Auth simple par jeton ---
const API_TOKEN = process.env.API_TOKEN; // à définir dans Render
app.use((req, res, next) => {
  if (!API_TOKEN) return next();               // si pas défini, on laisse passer (utile en dev)
  const auth = req.get("Authorization") || ""; // ex: "Bearer abc123"
  if (auth === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
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

// -------- start --------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ API up on :${PORT}`));
