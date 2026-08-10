# AGENTS.md — Leboncoin Scraper Pro

Repository knowledge for AI agents working on this codebase.

## Stack
- Electron app (main + renderer, contextIsolation + sandbox)
- Node.js main process, Playwright (Chromium) pour le scraping
- ExcelJS pour l'export .xlsx
- IA 100% locale via Ollama (texte : llama3/mistral, vision : llava/moondream)
- IA Marché : recherche Web sans-clé (DuckDuckGo Lite) + estimation IA

## Architecture IA (3 systèmes, nouvelle archi v2)
```
services/ai/
  adAnalyzer.js          IA 1 — Analyse pendant le scraping (texte + vision)
                         → adAnalysis { identifiedName, summary, vision{...}, _fallback }
  marketValueAnalyzer.js IA 2 — Marché : recherche Internet + verdict en €
                         → marketAnalysis { verdict, verdictLabel, deltaEur, realValue,
                           marketMin/Max, sources[], rationale, _fallback }
  promptGenerator.js     IA 3 — Prompt (~50 lignes, tout produit) via getAIProvider
  providers/             interface AIProvider + OllamaProvider + aiProviderRegistry
  search/                interface SearchProvider + DuckDuckGoSearchProvider (keyless) + registry
  aiCache.js             cache préfixé (analyse: / market:) — MAX 5000 entrées
  ollamaHealth.js        santé + modèles Ollama
services/analysis/
  adStats.js             statistiques de prix brutes (remplace dealFinder — PLUS de scoring)
```

### Champs d'annonce (nouveau schéma)
- `adAnalysis` : identifié par l'IA 1 (identifiedName, summary, vision, _fallback)
- `marketAnalysis` : produit par l'IA 2 (verdict, deltaEur, realValue, sources, rationale)
- ANCIENS champs SUPPRIMÉS : classification, diffPct, netMarginEur, scamScore,
  dealTag, dealDiscountPct, hasRisk, detectedRisks, points, multipliers, roiPct

## Architecture (src/main/)
```
main.js                      cycle de vie Electron, fenêtres, single-instance lock
core/ipcHandlers.js          TOUS les handlers IPC (job, IA, fichiers, secrets, search)
core/settings.js             persistance user-settings.json
config/constants.js          BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH (require electron/app)
config/risk-keywords.js      mots-clés de risque (legacy, plus utilisé par scoring)
services/scraping/           harCapturer (Playwright) + pipelineRunner (fork) + leboncoin-pipeline
services/ai/                 adAnalyzer, marketValueAnalyzer, promptGenerator, aiCache, ollamaHealth, providers/, search/
services/jobs/               jobHistory (listing/lecture/suppression jobs, stats via AdStats)
services/analysis/adStats.js statistiques de prix (sans scoring — remplace dealFinder)
services/maintenance/storageCleaner
infrastructure/              excelExporter, fileManager, notifications
utils/                      helpers, diagnostics, integrity, rateLimiter, logger, secretStore
renderer/                    app.js, index.html, styles.css, widget.html, aiStudioModule.js, helpModule.js (FAQ/Help/Feedback)
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
- IA Providers : NE PAS faire de fetch direct dans adAnalyzer/marketValueAnalyzer/
  promptGenerator — toujours passer par `getAIProvider()` (abstraction Ollama/etc.).
- Search Providers : NE PAS faire de fetch direct dans marketValueAnalyzer —
  toujours passer par `getSearchProvider()` (abstraction DuckDuckGo/etc.).

## Tests
- `node test/regression.test.js` → 318 assertions (syntaxe + stubs Electron).
- Le test stub `electron` : BrowserWindow a `webContents.send` mais PAS `isDestroyed`.
- Avant tout commit : `node --check` sur les fichiers modifiés + lancer la suite.
- aiCache est testé en isolation (variable `_aiCacheUnderTest` pour éviter la
  redéclaration avec la section plafond/éviction existante plus loin).

## Pièges corrigés (audit 2026-08) — à ne PAS réintroduire
- **aiCache.get()** doit renvoyer la VALEUR mise en cache (entry.specs), PAS le
  wrapper `{ specs, cachedAt }`. Sinon AdAnalyzer/MarketValueAnalyzer reçoivent
  un objet sans `identifiedProduct`/`realValue`/`_fallback` → affichage IA cassé
  ET un fallback caché est retourné à tort comme valide (la détection `!cached._fallback`
  devient toujours vraie).
- **Cohérence des noms de champs IA ↔ consommateurs** :
  - AdAnalyzer produit `identifiedProduct` (PAS `identifiedName`).
  - MarketValueAnalyzer produit `valueRangeLow`/`valueRangeHigh` (PAS `marketMin`/`marketMax`).
  - Le renderer (app.js) utilise les bons noms ; l'ExcelExporter lisait les anciens
    → colonnes « Produit Identifié (IA) » et « Fourchette Marché (€) » toujours vides.
  - Avant d'ajouter un consommateur d'IA, vérifier les champs réellement produits
    par adAnalyzer.js / marketValueAnalyzer.js (le prompt JSON spec est la source de vérité).
- **AdStats médiane** : pour un nombre pair de prix, moyenne des deux valeurs
  centrales (le renderer fait pareil dans renderStatsView). Ne pas reprendre
  `validPrices[Math.floor(n/2)]` qui est faux pour les longueurs paires.

## Code mort retiré
- `runWithConcurrency` et `formatDuration` (utils/helpers.js) n'étaient utilisés
  nulle part (les batchs IA utilisent leur propre queue de workers).

## Sécurité (déjà en place)
- Renderer sandboxé (sandbox:true, contextIsolation:true, nodeIntegration:false)
- `shell:openExternal` filtré (http/https uniquement)
- `file:openFolder/openFile` validés contre BASE_OUT_DIR (anti path-traversal)
- Clés API via `safeStorage` (secretStore.js), pas en clair

## Commandes
- Lancer l'app : `npm start` (electron --max-old-space-size=8192 .)
- Tests : `node test/regression.test.js`
- Branche stable : `refactor/professional-architecture`
