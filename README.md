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
│       └── builds/<id>/vN/  # generated sites, versioned
└── start.sh
```

---

## Part 1 — Survey

Open `survey/index.html` directly, or deploy the `survey/` folder to Netlify / Vercel / GitHub Pages / any static host.

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

### About "Load from browser storage"

`localStorage` is per-origin, so the dashboard can only read `website_requests` written by a survey served from the **same origin**. The dashboard serves a copy of the survey at <http://localhost:4321/survey/> — fill it there and *Load from browser storage* works. For surveys hosted elsewhere, use the downloaded JSON file.

### Models

Edit `dashboard/config.json`:

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
GET    /builds/:id/vN/index.html        # preview
```

The server binds to `127.0.0.1` only.
