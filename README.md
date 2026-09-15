# Website Studio

Two parts:

1. **`survey/`** — a public survey page clients fill in. Static HTML/CSS/JS, host it anywhere.
2. **`dashboard/`** — a local, offline dashboard that turns a survey request into a finished website with a local LLM, lets you preview / rebuild it, and packages it as a ZIP to hand over.

No npm dependencies. Requires **Node ≥ 18** and (for AI builds) **[Ollama](https://ollama.com)**.

```
website-studio/
├── survey/                  # PART 1 – public survey (deploy anywhere)
│   ├── index.html
│   ├── styles.css
│   └── survey.js
├── dashboard/               # PART 2 – local, offline
│   ├── server.js            # http server + API (zero deps)
│   ├── config.json          # model / endpoint settings
│   ├── lib/
│   │   ├── llm.js           # Ollama → OpenAI-compatible (Kimi / LM Studio…) → template
│   │   ├── prompt.js        # survey → prompt, output parser
│   │   ├── template.js      # deterministic fallback site generator
│   │   └── zip.js           # ZIP writer (deflate via zlib)
│   ├── public/              # dashboard UI
│   └── data/
│       ├── requests/        # imported requests, one JSON per client
│       ├── business/<id>/   # fetched Google listing + photos
│       └── builds/<id>/vN/  # generated sites, versioned
└── start.sh
```

---

## Part 1 — Survey

**Live:** <https://jonasvh24.github.io/website-studio/> (auto-deployed from `survey/` on every push to `main` via `.github/workflows/pages.yml`). On GitHub Pages there is no form backend, so the customer downloads the JSON and emails it; host on Netlify (see below) to receive submissions automatically.

Settings live in `survey/config.js`: contact email shown to the customer, remote mode (`netlify`, `auto`, or none), an optional custom endpoint, and upload limits.

You can also open `survey/index.html` directly, or deploy the `survey/` folder to Netlify / Vercel / any static host.

On submit the page:
- validates name, email and description,
- builds a clean JSON object,
- **downloads** it as `website-request_<name>_<date>.json`,
- appends it to `localStorage["website_requests"]`,
- shows a success screen.

The client sends you the JSON file (or you collect it however you like).

### JSON shape

```json
{
  "id": "req_…", "submittedAt": "2026-09-15T09:30:00.000Z", "version": 1,
  "client":  { "fullName", "email", "location", "title", "bio" },
  "website": { "type", "description", "stylePreferences": [], "colorPreference" },
  "social":  { "github", "linkedin", "twitter", "currentWebsite" },
  "business": { "name", "location", "usePublicData": true },
  "domain":   { "name", "registrar", "canGiveAccess": false },
  "files":    [ { "name", "type", "size", "kind": "image|document", "dataUrl": "data:..." } ],
  "extraNotes": "",
  "meta": { "userAgent", "language", "source": "public-survey" }
}
```

---

## Part 2 — Dashboard

```bash
./start.sh            # or: cd dashboard && node server.js
# → http://localhost:4321
```

### Workflow

| Step | What happens |
|---|---|
| **1 · Select** | Import JSON files (button or drag-and-drop), or *Load from browser storage*. Pick a client. |
| **2 · Review** | All collected information on one screen. |
| **3 · Build** | Click **Build Website**. The local model streams progress; the result is saved as a new version. |
| **4 · Preview** | Live iframe with desktop / tablet / mobile widths and a version switcher. |
| **5 · Deliver** | **Request Rebuild** (with feedback → new version) or **Transfer Ownership – Download ZIP**. The client's email is shown prominently when the download starts and finishes. |

### How requests reach the dashboard

Three ways, all automatic once set up:

1. **Watched folders.** The dashboard watches `~/Downloads` (and `dashboard/data/inbox/`) every 5 seconds and imports any `website-request_*.json` it finds. Filling in the survey on this machine is enough; the downloaded file is picked up within seconds. Nothing is moved or deleted; a ledger in `data/inbox-ledger.json` remembers what was imported.
2. **Netlify Forms** (for customers on other machines). Host the survey on Netlify; the survey posts every submission to Netlify Forms and the dashboard pulls them every 60 seconds. Setup:
   ```bash
   npx netlify-cli login                       # one time, opens the browser
   npx netlify-cli deploy --prod --dir=survey  # creates the site, prints the URL
   ```
   Submit the form once on the new URL so Netlify registers it, then put a personal access token (Netlify: User settings, Applications) and the site id (Site settings, General) in `dashboard/config.local.json`:
   ```json
   { "netlify": { "token": "nfp_...", "siteId": "xxxxxxxx-xxxx-..." } }
   ```
   The **Check now** button on step 1 syncs immediately.
3. **Manual.** Import JSON files with the button or drag and drop, or paste any endpoint that accepts a JSON POST into `survey/config.js` (`endpoint`).

Photos and documents the customer attached are embedded in the JSON (images are resized in the browser first) and unpacked to `data/uploads/<id>/` on import. They are copied into every build under `assets/` and included in the ZIP.

### About "Load from browser storage"

`localStorage` is per-origin, so the dashboard can only read `website_requests` written by a survey served from the **same origin**. The dashboard serves a copy of the survey at <http://localhost:4321/survey/> — fill it there and *Load from browser storage* works. For surveys hosted elsewhere, use the downloaded JSON file.

### Business reviews and photos (Google Places)

If the client entered a business name, the Review step shows a **Business listing** block. Click **Find business**, pick the right listing, and the dashboard pulls:

- rating, review count, up to 5 reviews (author, stars, text)
- address, phone, opening hours, Google Maps link, category
- up to 6 photos (saved locally, copied into every build under `assets/`, included in the ZIP)

The build prompt and the fallback template use all of it: testimonials section, gallery, hero image, contact details. If the client unticked "Use my business's public reviews and photos", the block only shows the survey answers and nothing is fetched.

Setup (one time):

1. In Google Cloud Console create a project, enable **Places API (New)**, create an API key.
2. Create `dashboard/config.local.json` (git-ignored):

```json
{ "googlePlaces": { "apiKey": "YOUR_KEY" } }
```

or set `GOOGLE_PLACES_API_KEY` in the environment. Without a key the rest of the dashboard works as before.

Google's terms require attribution when you show their reviews and photos; the photo author names are stored in `data/business/<id>/business.json` (`photos[].credit`) and reviews carry the author name.

### Models

Order of preference: **Kimi** (Moonshot, cloud) if a key is configured, then **Ollama** (local), then the built-in template. Each build has a model picker on step 3.

To use Kimi, get a key at platform.moonshot.ai and add it to `dashboard/config.local.json`:

```json
{ "openaiCompatible": { "apiKey": "sk-..." } }
```

With `"model": "auto"` (the default) the newest Kimi generation the API lists is used (K3 if available, otherwise K2.5, K2). Set an explicit model id to pin one.

**Default: `gpt-oss:120b-cloud`.** This is an Ollama cloud model: it runs on ollama.com using the machine's `ollama signin` (free tier) and builds a site in about 15 seconds with much better quality than the local models. Kimi models (`kimi-k3:cloud`, `kimi-k2.7-code:cloud`) are also in Ollama's cloud catalogue but require a paid ollama.com plan or credits; once the account has them, pull with `ollama pull kimi-k3:cloud` and they appear in the picker.

Local models: `qwen2.5:14b` takes about 5 minutes per site; `qwen2.5:72b` is impractically slow on this machine (about 1 token per second).

Edit `dashboard/config.json` (or override in `config.local.json`):

```jsonc
{
  "port": 4321,
  "ollama": {
    "enabled": true,
    "baseUrl": "http://localhost:11434",
    "model": "qwen2.5:14b",          // any pulled model; qwen2.5:72b gives richer sites (slower)
    "numCtx": 16384, "maxTokens": 8192, "temperature": 0.4
  },
  "openaiCompatible": {              // fallback when Ollama is down
    "enabled": false,
    "label": "Kimi",
    "baseUrl": "https://api.moonshot.ai/v1",   // or http://localhost:1234/v1 for LM Studio, etc.
    "model": "kimi-k2-0711-preview",
    "apiKey": ""                     // or env KIMI_API_KEY / OPENAI_API_KEY
  }
}
```

Fallback order: **Ollama → OpenAI-compatible endpoint → built-in template generator**. The template generator still produces a clean, personalised site from the survey data, so the workflow never blocks.

If the model forgets a file (e.g. returns only `index.html`), the missing files are filled from the template and a warning is shown in the build log. The raw model output of the last build is kept at `data/builds/<id>/last-raw-output.txt` for debugging.

### API (for scripting)

```
GET    /api/status
GET    /api/requests
POST   /api/requests                    # one request object or an array
GET    /api/requests/:id
DELETE /api/requests/:id
POST   /api/requests/:id/build          # SSE stream, body { "feedback": "" }
GET    /api/requests/:id/builds
GET    /api/requests/:id/zip?v=N        # ZIP download (header X-Client-Email)
GET    /api/business/search?q=          # Google Places candidates
POST   /api/requests/:id/business       # { placeId } fetch reviews + photos
DELETE /api/requests/:id/business
GET    /builds/:id/vN/index.html        # preview
```

The server binds to `127.0.0.1` only.
