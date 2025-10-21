Stremio Translate Subtitles Addon (EN -> HE)
--------------------------------------------

What it is:
- A small Node.js service that exposes a Stremio-style manifest and endpoints to translate subtitles
  from English to Hebrew using the unofficial Google Translate endpoint (no API key).
- It provides /manifest.json, /subtitles and /translate endpoints.

How to use:
1. Install Node.js (16+ recommended).
2. Unzip this package and run `npm install` in the project folder.
3. Start the service: `npm start` (default port 7000).
4. Expose the server publicly (Stremio needs a reachable URL) using ngrok or deploy to a VPS / cloud.
   Example: `ngrok http 7000` will provide a public URL like https://abc123.ngrok.io
5. Add the addon to Stremio: In Stremio go to Add-ons -> My addons -> Add addon by URL -> paste `https://yourhost/manifest.json`.
6. When watching a video, open Subtitles -> More (or search subtitle providers). If the stream's subtitle URL is known,
   the addon can be requested with a `?url=` parameter to /subtitles. You can also manually use the addon endpoints:
   - Request a subtitle list: `https://yourhost/subtitles?url=<original_sub_url>&title=<optional title>`
   - Directly get translated subtitle: `https://yourhost/translate?url=<original_sub_url>`

Notes & caveats:
- The addon needs to fetch the original subtitle via a public URL. If the subtitle is embedded or local on your machine,
  Stremio may not expose a direct URL; in that case you can download the subtitle to a reachable location or host it locally and supply its URL.
- The unofficial Google Translate endpoint may stop working if Google changes it.
- For convenience, the addon caches translations in the `cache/` folder.
