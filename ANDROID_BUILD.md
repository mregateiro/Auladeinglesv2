# 📱 Android Build Guide

This branch contains a **self-contained Android app** version of the learning platform. The Node.js server and client UI have been merged into a single offline-capable app that runs entirely in the browser WebView.

## Architecture

```
┌──────────────────────────────────┐
│     Android WebView (Capacitor)  │
│  ┌────────────────────────────┐  │
│  │  app.js (UI)               │  │
│  │    ↓ api() calls           │  │
│  │  local-api.js (router)     │  │
│  │    ↓                       │  │
│  │  local-db.js (localStorage)│  │
│  │  local-llm.js (fetch→LLM) │  │
│  │  local-generator.js        │  │
│  │  courses-data.js (bundled) │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
         ↕ HTTPS (internet)
    ┌─────────────┐
    │  LLM API    │
    │  (OpenAI,   │
    │   Gemini,   │
    │   etc.)     │
    └─────────────┘
```

**What changed from the server version:**
- **Database**: Server's JSON file → `localStorage` in the browser
- **LLM calls**: Go directly from the app to the LLM API (no server proxy)
- **Courses**: Bundled as JavaScript data (no filesystem reads)
- **Auth**: Simplified to local profiles only (no Google OAuth)
- **API routing**: `LocalAPI.handle()` intercepts all `api()` calls and processes them locally

## Prerequisites

1. **Node.js** ≥ 18
2. **Android Studio** (latest stable) with:
   - Android SDK (API 24+)
   - Android Build Tools
   - An Android emulator or physical device
3. **Java JDK** 17+

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Add the Android platform

```bash
npx cap add android
```

### 3. Sync web assets to the Android project

```bash
npx cap sync android
```

### 4. Open in Android Studio

```bash
npx cap open android
```

Then click **Run** ▶️ in Android Studio to build and deploy to an emulator or device.

### 5. Build APK from command line (alternative)

```bash
cd android
./gradlew assembleDebug
```

The APK will be at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

## How It Works

### No Server Required
The app runs entirely client-side. All the server logic (database, LLM client, content generator) has been ported to browser JavaScript modules:

| Server file | Android equivalent | Storage |
|---|---|---|
| `database.js` | `public/js/local-db.js` | `localStorage` |
| `llm.js` | `public/js/local-llm.js` | Direct `fetch()` calls |
| `generator.js` | `public/js/local-generator.js` | Uses LocalDB + LocalLLM |
| `courses/*.json` | `public/js/courses-data.js` | Bundled in JS |
| `server.js` (routes) | `public/js/local-api.js` | URL pattern matching |

### LLM Configuration
Since there's no server to provide a default LLM, users need to configure an LLM provider:

1. On the user selection screen, tap **⚙️ Configuração IA**
2. Choose a provider (OpenAI, Gemini, Groq, etc.)
3. Enter the API URL and model
4. If needed, enter the API key and a PIN to encrypt it
5. Tap **💾 Guardar**

The API key is encrypted with AES-GCM using the PIN and stored locally. It's never transmitted unencrypted.

### CORS Note
LLM API calls go directly from the WebView to the LLM provider's API. Inside Capacitor's Android WebView, CORS restrictions don't apply, so this works seamlessly. If testing in a regular browser, you may need a CORS proxy or a local LLM (Ollama).

## Building a Release APK

For a signed release APK suitable for distribution:

1. In Android Studio, go to **Build → Generate Signed Bundle / APK**
2. Create or select a signing key
3. Choose **APK** and **release** build type
4. The signed APK will be in `android/app/build/outputs/apk/release/`

## Updating Course Data

To update the bundled courses:

1. Edit files in `courses/*.json`
2. Run the bundler:
   ```bash
   node -e "
   const fs = require('fs');
   const path = require('path');
   const courses = {};
   for (const f of fs.readdirSync('courses').filter(f => f.endsWith('.json'))) {
     const data = JSON.parse(fs.readFileSync(path.join('courses', f), 'utf-8'));
     courses[data.id] = data;
   }
   const js = '// Auto-generated from courses/*.json\\nconst CoursesData = ' + JSON.stringify(courses, null, 2) + ';\\n';
   fs.writeFileSync('public/js/courses-data.js', js);
   console.log('Updated courses-data.js');
   "
   ```
3. Re-sync: `npx cap sync android`

## Running the Web Version

The original server version still works on the `main` branch:
```bash
git checkout main
npm start
```

On this branch, you can still open `public/index.html` directly in a browser for testing (LLM calls may need a local provider like Ollama due to CORS).
