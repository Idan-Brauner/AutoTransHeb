// index.js (core parts)
// NOTE: paste this into your repo index.js replacing the old translate logic.
// Requires package.json dependencies: express, node-fetch, morgan, iconv-lite, cors

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());
app.use(morgan('tiny'));

const PORT = process.env.PORT || 7000;
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// OpenSubtitles API key (set this as env var on Render: OPENSUBTITLES_API_KEY)
const OS_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';

/**
 * Helper: translate text using unofficial Google Translate endpoint
 */
async function translateTextViaGoogle(text, target = 'he') {
  if (!text) return text;
  // break into chunks (safe size)
  const CHUNK = 2500;
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  const outParts = [];
  for (const c of chunks) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(c);
    const r = await fetch(url, { timeout: 20000 });
    if (!r.ok) {
      // fallback: keep original
      outParts.push(c);
      continue;
    }
    const raw = await r.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      try { parsed = eval(raw); } catch(e2) { parsed = null; }
    }
    if (parsed && Array.isArray(parsed[0])) {
      for (const seg of parsed[0]) {
        if (seg && seg[0]) outParts.push(seg[0]);
      }
    } else {
      outParts.push(c);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return outParts.join('');
}

/**
 * Basic SRT parser & writer
 */
function parseSrt(text) {
  const parts = text.split(/\r?\n\r?\n/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const lines = p.split(/\r?\n/).map(l => l.trim());
    if (lines.length >= 2) {
      // if first is numeric index, timeline is second; otherwise timeline first match
      let idx = lines[0], timeline = '', bodyLines = [];
      if (/^\\d+$/.test(lines[0]) && lines.length >= 3) {
        idx = lines[0];
        timeline = lines[1];
        bodyLines = lines.slice(2);
      } else {
        timeline = lines[1];
        bodyLines = lines.slice(2);
      }
      out.push({ index: idx, timeline: timeline, text: bodyLines.join('\\n') });
    }
  }
  return out;
}

function writeSrt(blocks) {
  let out = '';
  for (let i = 0; i < blocks.length; i++) {
    out += `${i+1}\\n${blocks[i].timeline}\\n${blocks[i].text}\\n\\n`;
  }
  return out;
}

function fixPunctuation(text) {
  if (!text) return text;
  text = text.replace(/\\s+([\\.,:;!\\?])/g, '$1');
  text = text.replace(/([\\.,:;!\\?])(\\S)/g, '$1 $2');
  text = text.replace(/ {2,}/g, ' ');
  return text;
}

/**
 * Fetch subtitle file bytes, decode to UTF-8 text (with fallback to windows-1255)
 */
async function fetchSubtitleText(url) {
  const r = await fetch(url, { timeout: 20000 });
  if (!r.ok) throw new Error('failed to fetch original subtitle: ' + r.status);
  const buf = await r.buffer();
  let text;
  try {
    text = buf.toString('utf8');
    if (!text || text.trim().length === 0) throw new Error('empty after utf8');
  } catch (e) {
    try { text = iconv.decode(buf, 'windows-1255'); } catch (_) { text = buf.toString('binary'); }
  }
  return text;
}

/**
 * GET /manifest.json
 */
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "org.custom.stremio.translate_subs",
    version: "1.0.0",
    name: "Translate Subtitles (EN→HE)",
    description: "Translates subtitle files to Hebrew on-the-fly (uses unofficial Google endpoint).",
    resources: ["subtitles"],
    types: ["movie","series","episode"],
    idPrefixes: [], 
    contactEmail: "none@example.com",
    logo: "https://raw.githubusercontent.com/stremio/stremio-addons/master/logo.png",
    catalogs: []
  };
  res.json(manifest);
});

/**
 * Helper: search OpenSubtitles for subtitles by video hash or name.
 * Returns array of {lang, url, fileName}
 * Requires OPENSUBTITLES_API_KEY in env.
 */
async function searchOpenSubtitlesByHash(videoHash, videoSize, languages = 'en') {
  if (!OS_API_KEY) return []; // no API key configured
  try {
    // recommended: use OpenSubtitles REST API v1:
    // https://opensubtitles.stoplight.io/docs/opensubtitles-api
    const queryUrl = `https://api.opensubtitles.com/api/v1/subtitles?moviehash=${encodeURIComponent(videoHash)}&languages=${languages}`;
    const r = await fetch(queryUrl, { headers: { 'Api-Key': OS_API_KEY } });
    if (!r.ok) return [];
    const json = await r.json();
    if (!json || !json.data) return [];
    // pick downloadable file URLs
    const results = [];
    for (const item of json.data) {
      if (item.attributes && item.attributes.url) {
        results.push({
          lang: item.attributes.language,
          url: item.attributes.url,
          fileName: item.attributes.filename || item.attributes.files?.[0]?.file?.name || 'subtitle.srt'
        });
      } else if (item.attributes && item.attributes.files && item.attributes.files.length) {
        // sometimes url is in files entries
        for (const f of item.attributes.files) {
          if (f.file && f.file.url) {
            results.push({ lang: item.attributes.language, url: f.file.url, fileName: f.file.name });
          }
        }
      }
    }
    return results;
  } catch (e) {
    console.error('OpenSubtitles search failed', e);
    return [];
  }
}

/**
 * GET /subtitles
 * Stremio will call this with a query object:
 * ?query.itemHash=...&query.videoHash=...&query.videoSize=... etc (sometimes nested JSON)
 * We'll support both query params and raw JSON query string.
 */
app.get('/subtitles', async (req, res) => {
  try {
    // parse common fields
    const rawQuery = req.query.query || null;
    let q = {};
    if (rawQuery) {
      try { q = JSON.parse(rawQuery); } catch(e){ q = {}; }
    } else {
      // maybe fields are top-level query.videoHash etc
      ['videoHash','videoSize','videoName','itemHash'].forEach(k => {
        if (req.query[k]) q[k] = req.query[k];
      });
    }

    // If no identifying metadata available, return a generic "always-available" entry
    // so addon shows in UI. But real translation needs an original subtitle URL -- we will
    // show an entry only if we can resolve a subtitle URL.
    const videoHash = q.videoHash || null;
    const videoSize = q.videoSize || q.video_size || null;
    const videoName = q.videoName || q.video_name || q.video_name || null;

    // Try to find English subtitles from OpenSubtitles (if API key set)
    let found = [];
    if (videoHash) {
      found = await searchOpenSubtitlesByHash(videoHash, videoSize, 'eng');
    }

    // If none found by hash, try a fallback search by name (if we have it)
    if ((!found || found.length === 0) && videoName && OS_API_KEY) {
      const qname = encodeURIComponent(videoName.replace(/\s+/g,' '));
      const queryUrl = `https://api.opensubtitles.com/api/v1/subtitles?query=${qname}&languages=eng`;
      try {
        const r = await fetch(queryUrl, { headers: { 'Api-Key': OS_API_KEY }});
        if (r.ok) {
          const j = await r.json();
          if (j && j.data) {
            for (const item of j.data) {
              if (item.attributes && item.attributes.url) found.push({ lang: item.attributes.language, url: item.attributes.url, fileName: item.attributes.filename });
            }
          }
        }
      } catch(e){}
    }

    // If we found English subtitles, reply with entries pointing to our /translate?url=...
    const response = [];
    for (const f of found) {
      if (f.lang && (f.lang === 'eng' || f.lang === 'en')) {
        const translateUrl = `${req.protocol}://${req.get('host')}/translate?url=${encodeURIComponent(f.url)}`;
        response.push({
          id: encodeURIComponent(f.url),
          name: `${f.fileName || 'English subtitle'} (HE)`,
          lang: 'he',
          url: translateUrl,
          encoding: 'utf-8',
          rel: 'subtitle'
        });
      }
    }

    // If no OpenSubtitles results but the client supplied a direct subtitle URL (rare),
    // honor that as well (some clients pass ?url=...).
    if (req.query.url && response.length === 0) {
      const translateUrl = `${req.protocol}://${req.get('host')}/translate?url=${encodeURIComponent(req.query.url)}`;
      response.push({
        id: encodeURIComponent(req.query.url),
        name: 'Translated subtitle (HE)',
        lang: 'he',
        url: translateUrl,
        encoding: 'utf-8',
        rel: 'subtitle'
      });
    }

    // If still nothing, return empty array.
    res.json(response);
  } catch (err) {
    console.error('subtitles find error', err);
    res.json([]);
  }
});

/**
 * GET /translate?url=<original_sub_url>
 * Fetches original subtitle, translates to Hebrew, returns srt/vtt
 */
app.get('/translate', async (req, res) => {
  const orig = req.query.url;
  if (!orig) return res.status(400).send('missing url param');
  try {
    const cacheFile = path.join(CACHE_DIR, encodeURIComponent(orig) + '.he.srt');
    if (fs.existsSync(cacheFile)) {
      const cached = fs.readFileSync(cacheFile, 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(cached);
    }

    const text = await fetchSubtitleText(orig);
    const isVtt = orig.toLowerCase().endsWith('.vtt');
    const blocks = parseSrt(text);
    const translatedBlocks = [];

    for (const b of blocks) {
      const translated = await translateTextViaGoogle(b.text, 'he');
      const fixed = fixPunctuation(translated);
      translatedBlocks.push({ timeline: b.timeline, text: fixed });
      await new Promise(r => setTimeout(r, 200));
    }

    const out = writeSrt(translatedBlocks);
    fs.writeFileSync(cacheFile, out, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(out);

  } catch (e) {
    console.error('translate error', e);
    res.status(500).send('translation error: ' + e.message);
  }
});


app.listen(PORT, () => {
  console.log('Stremio Translate Subtitles addon running on port', PORT);
});
