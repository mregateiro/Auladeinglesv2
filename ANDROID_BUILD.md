# 📱 Building the Android APK

This guide explains how to compile the **Aula de Inglês** app into an Android APK.

## Prerequisites

1. **Node.js** (v18 or later) — [nodejs.org](https://nodejs.org/)
2. **Android Studio** (2024.1 or later) — [developer.android.com/studio](https://developer.android.com/studio)
3. **Android SDK** — installed via Android Studio
   - SDK Platform: API 35 (Android 15) or latest
   - Build Tools: 35.0.0 or latest
4. **Java JDK 17** — usually bundled with Android Studio

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Sync web assets to the Android project
npx cap sync android

# 3. Build the debug APK
cd android
./gradlew assembleDebug
```

The APK will be at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

## Step-by-step Guide

### 1. Clone and Install

```bash
git clone https://github.com/mregateiro/Auladeinglesv2.git
cd Auladeinglesv2
git checkout androidapk
npm install
```

### 2. Sync Web Assets

Every time you change files in `public/`, run:

```bash
npx cap sync android
```

This copies `public/` into the Android project and updates native dependencies.

### 3. Build Debug APK (command line)

```bash
cd android
./gradlew assembleDebug
```

The debug APK will be at: `android/app/build/outputs/apk/debug/app-debug.apk`

### 4. Build Release APK (command line)

```bash
cd android
./gradlew assembleRelease
```

> ⚠️ Release builds need a signing key. See [Android signing docs](https://developer.android.com/studio/publish/app-signing) for details.

### 5. Open in Android Studio (GUI)

```bash
npx cap open android
```

This opens the project in Android Studio where you can:
- Run on an emulator or connected device
- Build signed APKs/AABs via Build → Generate Signed Bundle / APK
- Debug with Android Studio's tools

## NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run cap:sync` | Sync web assets to Android project |
| `npm run cap:open` | Open Android project in Android Studio |
| `npm run cap:build` | Sync + build debug APK |
| `npm run cap:build-release` | Sync + build release APK |

## How it Works

This is a **Capacitor** app — it wraps the web app (HTML/CSS/JS) in a native Android WebView.

The app runs **entirely client-side** — no server needed:

| Server module | Client-side replacement | What it does |
|---------------|------------------------|--------------|
| `database.js` | `public/js/local-db.js` | localStorage instead of file-based JSON |
| `llm.js` | `public/js/local-llm.js` | Browser `fetch()` to LLM APIs |
| `generator.js` | `public/js/local-generator.js` | Content generation (same prompts) |
| `server.js` | `public/js/local-api.js` | URL router replacing Express endpoints |
| `courses/*.json` | `public/js/courses-data.js` | Bundled course data (no file system) |

### LLM Configuration

The app needs an LLM provider to generate lessons. Users configure this in the app's Settings:
- **Local LLM** (Ollama, LM Studio): Point to a server on your network
- **Cloud LLM** (OpenAI, Groq, Gemini, etc.): Enter your API key

API keys are encrypted with AES-GCM using a user-chosen PIN and stored in the device's localStorage.

## Troubleshooting

### "SDK location not found"
Create `android/local.properties` with your Android SDK path:
```
sdk.dir=/Users/yourname/Library/Android/sdk
```
Or on Windows:
```
sdk.dir=C\:\\Users\\yourname\\AppData\\Local\\Android\\Sdk
```

### "Could not determine Java version"
Make sure `JAVA_HOME` points to JDK 17:
```bash
export JAVA_HOME=/path/to/jdk-17
```

### Web assets not updating
Run `npx cap sync android` to force-copy the latest `public/` files.

### Mixed content blocked
The app is configured with `androidScheme: "https"` and `allowMixedContent: true` in `capacitor.config.json` to allow requests to local HTTP LLM servers (like Ollama on `http://localhost:11434`).
