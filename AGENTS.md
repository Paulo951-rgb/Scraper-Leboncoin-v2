# AGENTS.md — Leboncoin Scraper Pro

Repository knowledge for AI agents working on this codebase.

## Stack
- Electron app (main + renderer, contextIsolation + sandbox)
- Node.js main process, Playwright (Chromium) pour le scraping
- ExcelJS pour l'export .xlsx
- IA : Ollama (local) / OpenAI / Google Gemini (analyse de marché + vision)

## Architecture (src/main/)
```
main.js                      cycle de vie Electron, fenêtres, single-instance lock
core/ipcHandlers.js          TOUS les handlers IPC (job, IA, scheduler, fichiers, secrets)
core/settings.js             persistance user-settings.json
config/constants.js          BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH (require electron/app)
config/risk-keywords.js      mots-clés de risque (arnaque)
services/scraping/           harCapturer (Playwright) + pipelineRunner (fork) + leboncoin-pipeline
services/ai/                 marketAnalyzer, globalAnalyzer, imageAnalyzer, aiCache, ollamaHealth
services/jobs/               jobHistory, jobScheduler (cron-like persisté)
services/analysis/dealFinder statistiques + tags GOOD/HIGH
services/maintenance/storageCleaner
infrastructure/              excelExporter, fileManager, notifications
utils/                      helpers, diagnostics, integrity, rateLimiter, logger, secretStore
renderer/                    app.js (1266 lignes), index.html, styles.css, widget.html
```

## Conventions clés
- Les handlers IPC sont enregistrés UNE SEULE FOIS (dans app.whenReady) via
  `setupIpcHandlers(getMainWindow)`. Le getter `getMainWindow()` renvoie null si
  la fenêtre est détruite — ne JAMAIS capturer `mainWindow` par closure.
- `sendLog/sendProgress/sendStatus` (ipcHandlers) utilisent `getWin()` qui garde
  contre les fenêtres détruites. Ne pas remettre d'appels directs `mainWindow.webContents.send`.
- Écriture JSON avec intégrité : `writeWithChecksum(path, data, replacer, space)`
  (src/main/utils/integrity.js). NE PAS utiliser `fs.writeFileSync` pour les
  fichiers d'annonces — cela casse la validation SHA-256.
- Fetch natif Node.js : PAS d'option `timeout`. Utiliser AbortController + setTimeout
  pour tous les fetch IA / images (sinon requête bloquée indéfiniment).
- `constants.js` et `logger.js` et `secretStore.js` require('electron') au
  top-level → NE JAMAIS les require depuis le pipeline sous-processus (fork), qui
  n'a pas accès à `app`.

## Tests
- `node test/regression.test.js` → 146 assertions (syntaxe + stubs Electron).
- Le test stub `electron` : BrowserWindow a `webContents.send` mais PAS `isDestroyed`.
- Avant tout commit : `node --check` sur les fichiers modifiés + lancer la suite.

## Sécurité (déjà en place)
- Renderer sandboxé (sandbox:true, contextIsolation:true, nodeIntegration:false)
- `shell:openExternal` filtré (http/https uniquement)
- `file:openFolder/openFile` validés contre BASE_OUT_DIR (anti path-traversal)
- Clés API via `safeStorage` (secretStore.js), pas en clair

## Commandes
- Lancer l'app : `npm start` (electron --max-old-space-size=8192 .)
- Tests : `node test/regression.test.js`
- Branche stable : `refactor/professional-architecture`
