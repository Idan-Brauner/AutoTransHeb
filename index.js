// Simple Stremio-style subtitles translator service (EN -> HE)
const express = require('express');
const fetch = require('node-fetch');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const app = express();
const PORT = process.env.PORT || 7000;
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(morgan('tiny'));

// Minimal manifest for Stremio to recognize subtitles resource
app.get('/manifest.json', (req, res) => {
  const manifest = {
    id: "org.custom.stremio.translate_subs",
    version: "1.0.0",
    name: "Translate Subtitles (EN→HE)",
    description: "Translates subtitle files to Hebrew on-the-fly (uses unofficial Google endpoint).",
    resources: ["subtitles"],
    types: ["movie", "series", "episode"],
    idPrefixes: [],
    contactEmail: "none@example.com",
    logo: "https://raw.githubusercontent.com/stremio/stremio-addons/master/logo.png",
    catalogs: []
  };
  res.json(manifest);
});

// Provide a subtitles list for a given original subtitle URL.
// Stremio may call this endpoint with parameters; we accept ?url=<original_sub_url>&title=<title>
app.get('/subtitles', async (req, res) => {
  const orig = req.query.url;
  const title = req.query.title || 'Translated subtitles';
  if (!orig) {
    return res.status(400).json({ error: 'missing url parameter' });
  }
  // The translated subtitle will be available at /translate?url=<orig>
  const translateUrl = `${req.protocol}://${req.get('host')}/translate?url=${encodeURIComponent(orig)}`;
  // Return as array of subtitles for Stremio to show
  res.json([{
    id: encodeURIComponent(orig),
    name: `${title} (HE)`,
    lang: 'he',
    url: translateUrl,
    encoding: 'utf-8',
    rel: 'subtitle'
  }]);
});

// Translate endpoint: fetches original subtitle and returns translated subtitle content
app.get('/translate', async (req, res) => {
  const orig = req.query.url;
  if (!orig) return res.status(400).send('missing url parameter');
  try {
    const cacheFile = path.join(CACHE_DIR, encodeURIComponent(orig) + '.he');
    if (fs.existsSync(cacheFile)) {
      const cached = fs.readFileSync(cacheFile, 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(cached);
    }
    // Fetch original subtitle content (binary safe)
    const r = await fetch(orig);
    if (!r.ok) return res.status(502).send('failed to fetch original subtitle');
    const buffer = await r.buffer();
    // try decoding as utf-8, fallback to windows-1255/1252 via iconv
    let text;
    try {
      text = buffer.toString('utf8');
      if (!text || text.trim().length === 0) throw new Error('empty after utf8');
    } catch (e) {
      text = iconv.decode(buffer, 'windows-1255');
    }
    // detect simple format by extension
    const isVtt = orig.toLowerCase().endsWith('.vtt');
    // parse into blocks (simple SRT parser)
    const blocks = parseSrtLike(text, isVtt);
    // translate each block's text via Google Translate unofficial endpoint, in small chunks
    const translatedBlocks = [];
    for (let blk of blocks) {
      const translated = await translateText(blk.text, 'he');
      const fixed = fixPunctuation(translated);
      translatedBlocks.push({ timeline: blk.timeline, text: fixed });
      // be polite, slight delay
      await sleep(200);
    }
    const out = isVtt ? blocksToVtt(translatedBlocks) : blocksToSrt(translatedBlocks);
    fs.writeFileSync(cacheFile, out, { encoding: 'utf8' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(out);
  } catch (err) {
    console.error(err);
    res.status(500).send('translation error: ' + err.message);
  }
});

// Helpers
function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function translateText(text, target='he'){
  if (!text || text.trim().length === 0) return text;
  // Use translate.googleapis.com unofficial endpoint
  const base = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(target) + '&dt=t&q=';
  // Break large text into max 3000 char chunks
  const chunks = chunkString(text, 3000);
  let outParts = [];
  for (let c of chunks) {
    const url = base + encodeURIComponent(c);
    const r = await fetch(url, { timeout: 15000 });
    if (!r.ok) {
      throw new Error('translate fetch failed: ' + r.status);
    }
    const raw = await r.text();
    // response is JS-like array; try to parse
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch(e){
      try { parsed = eval(raw); } catch(e2) { parsed = null; }
    }
    if (parsed && Array.isArray(parsed[0])) {
      for (let seg of parsed[0]) {
        if (seg && seg[0]) outParts.push(seg[0]);
      }
    } else {
      outParts.push(c); // fallback: keep original chunk
    }
    await sleep(150);
  }
  return outParts.join('');
}

function chunkString(str, size){
  const arr = [];
  for (let i=0; i<str.length; i+=size) arr.push(str.slice(i,i+size));
  return arr;
}

function parseSrtLike(text, isVtt){
  const out = [];
  if (isVtt){
    text = text.replace(/^WEBVTT.*\n/, '');
    const cueRegex = /([0-9:.\-\,\s]*-->[0-9:.\-\,\s]*)([\s\S]*?)(?=\n\n|$)/g;
    let m;
    while ((m = cueRegex.exec(text)) !== null){
      out.push({ timeline: m[1].trim(), text: m[2].trim() });
    }
  } else {
    const parts = text.split(/\n\s*\n/);
    for (let p of parts){
      const lines = p.split(/\n/).map(l => l.trim()).filter(l=>l.length>0);
      if (lines.length>=2){
        const timeline = lines[1];
        const txt = lines.slice(2).join('\n');
        out.push({ timeline: timeline, text: txt });
      }
    }
  }
  return out;
}

function blocksToSrt(blocks){
  let out = '';
  for (let i=0;i<blocks.length;i++){
    out += (i+1) + '\n' + blocks[i].timeline + '\n' + blocks[i].text + '\n\n';
  }
  return out;
}

function blocksToVtt(blocks){
  let out = 'WEBVTT\n\n';
  for (let b of blocks){
    out += b.timeline + '\n' + b.text + '\n\n';
  }
  return out;
}

function fixPunctuation(text){
  if (!text) return text;
  text = text.replace(/\s+([\.,:;!\?])/g, '$1');
  text = text.replace(/([\.,:;!\?])(\S)/g, '$1 $2');
  text = text.replace(/ {2,}/g, ' ');
  return text;
}

app.listen(PORT, () => {
  console.log('Stremio Translate Subtitles addon running on port', PORT);
  console.log('Manifest:', `http://localhost:${PORT}/manifest.json`);
});
