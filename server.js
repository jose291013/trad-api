import express from "express";
import { Pool } from "pg";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

// --- utils ---
const normalizeSource = (str="") => str
  .normalize("NFKD").toLowerCase()
  .replace(/\p{Diacritic}/gu,"").replace(/\s+/g," ").trim();

const makeChecksum = ({ sourceNorm, targetLang, selectorHash="" }) =>
  crypto.createHash("sha256").update(`${sourceNorm}::${targetLang}::${selectorHash}`).digest("hex");

// --- DB ---
const connectionString = process.env.POOL_DATABASE_URL || process.env.DATABASE_URL;
if(!connectionString){ console.error("Missing POOL_DATABASE_URL or DATABASE_URL"); process.exit(1); }
const pool = new Pool({ connectionString });

app.get("/health", (_,res)=>res.send("OK"));
app.get("/dbping", async (_,res)=>{
  try{ const {rows}=await pool.query("SELECT now() AS now"); res.json({ok:true, now:rows[0].now}); }
  catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

// Cherche en cache
app.post("/cache/find", async (req,res)=>{
  try{
    const { projectId=process.env.PROJECT_ID, sourceLang, targetLang, sourceText, selectorHash="" } = req.body||{};
    if(!projectId||!sourceLang||!targetLang||!sourceText) return res.status(400).json({error:"Missing fields"});
    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({ sourceNorm, targetLang, selectorHash });
    const { rows } = await pool.query(`
      SELECT id, source_text, translated_text, status
      FROM translations
      WHERE project_id=$1 AND source_lang=$2 AND target_lang=$3
        AND checksum=decode($4,'hex')
      LIMIT 1`, [projectId, sourceLang, targetLang, sumHex]);
    res.json({ hit: rows[0] || null });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Insère / met à jour en cache
app.post("/cache/upsert", async (req,res)=>{
  try{
    const {
      projectId=process.env.PROJECT_ID, sourceLang, targetLang,
      sourceText, translatedText, contextUrl=null, pagePath=null, selectorHash=null
    } = req.body||{};
    if(!projectId||!sourceLang||!targetLang||!sourceText||!translatedText) return res.status(400).json({error:"Missing fields"});

    const sourceNorm = normalizeSource(sourceText);
    const sumHex = makeChecksum({ sourceNorm, targetLang, selectorHash || "" });

    const { rows } = await pool.query(`
      INSERT INTO translations(
        project_id, source_lang, target_lang,
        source_text, source_norm, translated_text,
        context_url, page_path, selector_hash,
        checksum, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),'auto')
      ON CONFLICT (project_id, source_lang, target_lang, checksum)
      DO UPDATE SET
        translated_text = CASE WHEN NOT translations.is_locked THEN EXCLUDED.translated_text ELSE translations.translated_text END,
        context_url     = COALESCE(EXCLUDED.context_url, translations.context_url),
        page_path       = COALESCE(EXCLUDED.page_path, translations.page_path),
        selector_hash   = COALESCE(EXCLUDED.selector_hash, translations.selector_hash),
        updated_at = now()
      RETURNING *;
    `, [projectId, sourceLang, targetLang, sourceText, sourceNorm, translatedText, contextUrl, pagePath, selectorHash, sumHex]);

    res.json({ saved: rows[0] });
  }catch(e){ res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log(`API up on :${PORT}`));
