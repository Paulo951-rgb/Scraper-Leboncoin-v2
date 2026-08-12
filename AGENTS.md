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
                         → onLog callback (opts.onLog) pour logs détaillés [IA1] dans l'onglet Logs
  marketValueAnalyzer.js IA 2 — Marché : recherche Internet + verdict en €
                         → marketAnalysis { verdict, verdictLabel, deltaEur, realValue,
                           marketMin/Max, sources[], rationale, _fallback }
                         → onLog callback (opts.onLog) pour logs détaillés [IA2] dans l'onglet Logs
  promptGenerator.js     IA 3 — Prompt (~50 lignes, tout produit) via getAIProvider
                         (LEGACY — conservé pour compat, plus utilisé par l'UI IA Studio)
  promptTemplates.js    Bibliothèque de prompts préfaits (V2, remplace promptGenerator
                         dans l'UI IA Studio). 7 templates génériques à trous
                         ([TYPE_DE_PRODUIT], [BUDGET_MIN], etc.). Aucune IA, assemblage
                         instantané. API : listTemplates() / getTemplate() / buildPrompt().
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
renderer/                    app.js, index.html, styles.css, widget.html, aiStudioModule.js (V2: prompts préfaits à trous, plus de génération IA), helpModule.js (FAQ/Help/Feedback)
```

## Conventions clés
- Les handlers IPC sont enregistrés UNE SEULE FOIS (dans app.whenReady) via
  `setupIpcHandlers(getMainWindow)`. Le getter `getMainWindow()` renvoie null si
  la fenêtre est détruite — ne JAMAIS capturer `mainWindow` par closure.
- `sendLog/sendProgress/sendStatus` (ipcHandlers) utilisent `getWin()` qui garde
  contre les fenêtres détruites. Ne pas remettre d'appels directs `mainWindow.webContents.send`.
- **Logs IA** : AdAnalyzer/MarketValueAnalyzer acceptent `opts.onLog` pour envoyer
  leurs logs détaillés (préfixe `[IA1]`/`[IA2]`) vers le renderer via sendLog.
  Ne PAS utiliser `console.log/warn` direct dans ces services — invisible dans l'UI.
  Niveaux : `debug` (étapes détaillées, cachées en mode normal), `info` (début/fin
  de lot), `warn` (échecs avec fallback, JSON invalide).
- **Onglet Logs (renderer)** : buffer mémoire `_logBuffer` (MAX 3000) + filtrage
  rétroactif par mode (normal=info/warn/error, debug=tout). Auto-scroll ON par
  défaut. `sendSessionSummary()` en fin de job envoie un résumé formaté.
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
- **CAPTCHA détection** : le statut HTTP de la navigation initiale (`vStatus`)
  ne doit JAMAIS être utilisé pour le polling de résolution — il reste figé à
  403 même après résolution. Utiliser `_checkCaptcha(page)` (content-based) +
  `latestHttpStatus` (response listener dynamique) + confirmation 2s anti-faux-positif.
- **Pipeline exit code** : une erreur CLI doit faire `process.exit(1)` (pas 0).
  Sinon le PipelineRunner voit code 0 et croit que le pipeline a réussi.
- **Logs IA debug** : `images.reduce((s, img) => ... img.data.length)` — `img`
  est `{ data, mimeType }`, pas une string. `img.length` est `undefined`.

## Pièges corrigés (audit 2026-08, 2e passe fiabilité) — à ne PAS réintroduire
- **market:analyze concurrent** : le handler `market:analyze` doit être protégé par
  un verrou (`isMarketAnalyzing`) libéré dans `finally`. Sans cela, un double-clic
  lançait deux batches IA + deux `writeWithChecksum` en parallèle sur le même job
  → race sur annonces.json (dernier write gagne, ads perdues).
- **Écriture résumés IA** : `writeSummaryFile` doit utiliser `atomicWriteFileSync`
  (helpers.js), PAS `fs.writeFileSync` — ce dernier laissait `resumes-ia.json`
  tronqué en cas de crash pendant l'écriture.
- **Lecture annonces.json** : `job:start` et `market:analyze` doivent lire via
  `readWithChecksum` (utils/integrity.js). Le pipeline écrit avec `writeWithChecksum`
  (fichier `.sha256` adjacent). `readWithChecksum` valide l'intégrité et donne un
  message clair si corrompu, au lieu d'un `JSON.parse` qui throw silencieusement.
- **adAnalyzer images** : filtrer les URLs invalides (null/undefined/non-string/
  non-http) AVANT `downloadImage`. Sinon `fetch(null)` polluait les logs d'erreurs
  et pouvait faire échouer la vision IA sur une annonce entière.
- **harCapturer warmup cancel** : si l'utilisateur annule pendant la résolution
  CAPTCHA (fenêtre visible), NE PAS persister `storageState` — la session est
  encore bloquée (cookies anti-bot). Persister reviendrait à empoisonner tous les
  jobs suivants. Fermer sans `storageState()`.
- **harCapturer CAPTCHA — 4 pièges corrigés (5e passe)** :
  1. **Détection précoce** : `domcontentloaded` + `sleep(1500)` était trop tôt pour
     détecter le CAPTCHA au 1er scraping. Les iframes Arkose/Cloudflare chargent
     en JS après `domcontentloaded`. Fix : `networkidle` + `sleep(3000)`.
  2. **Détection mono-vecteur** : `_checkCaptcha` ne vérifiait que
     `document.body.innerText` → ratait les CAPTCHA en iframe cross-origin
     (Arkose/FunCaptcha/Cloudflare) et les redirections URL. Fix : vérifier aussi
     les iframes (`src` Arkose/hCaptcha/reCaptcha/Cloudflare), les éléments DOM
     (`#challenge-form`, `.cf-turnstile`) et l'URL (`/captcha`, `/challenge`).
  3. **Reload pendant résolution** : la boucle de résolution faisait
     `vPage.reload()` toutes les 2s → l'utilisateur ne pouvait pas résoudre le
     CAPTCHA (page réinitialisée en continu). Fix : POLLER le contenu sans
     recharger (l'utilisateur résout → le DOM change → les marqueurs disparaissent).
     Timeout max 10 min, polling 3s.
  4. **Post-CAPTCHA précipité** : la session était persistée immédiatement après
     résolution → cookie de validation pas encore posé → erreur au prochain goto.
     Fix : `waitForLoadState('networkidle')` + `sleep(2000)` grace period +
     re-vérification (Leboncoin peut afficher un 2e CAPTCHA consécutif).
  5. **CAPTCHA pendant capture = abandon** : si un CAPTCHA apparaissait pendant
     la boucle de capture HAR, le code faisait `break` avec "Relancez manuellement".
     Fix : fermer le contexte HAR, appeler `_warmupSession` (fenêtre visible),
     puis relancer la capture depuis la page bloquée.
  6. **UA différent entre warmup et capture (403 au 1er scrape)** : chaque
     `_newStealthContext` appelait `getRandomUserAgent()` → UA différent entre le
     warmup et la capture. Leboncoin détectait l'incohérence (mêmes cookies +
     UA différent) → HTTP 403 au 1er scraping. Fix : UA fixe choisi une fois dans
     le constructeur (`this._userAgent`), réutilisé par `_baseContextOptions`.
  7. **Pas de délai warmup→capture (rate-limit Leboncoin)** : le warmup (200) et
     la capture (403) arrivaient dans la même seconde → Leboncoin rate-limitait.
     Fix : `sleep(2000)` après warmup avant de créer le contexte HAR.
- **ipcHandlers const ads reassignment (crash IA)** : `const { data: ads } =
  readWithChecksum(...)` puis `ads = await AdAnalyzer.analyzeAds(ads)` →
  `TypeError: Assignment to constant variable`. L'IA tournait 40s puis crashait
  à l'assignation du résultat. Fix : `let adsWithAi = ads` + remplacer toutes les
  réf. à `ads` dans le bloc par `adsWithAi`.
- **Pipeline recyclage contexte** : `writeOutputs(ads)` DOIT être appelé AVANT
  `createStealthContext()` (recyclage). Si le recyclage échoue, les ads sont déjà
  sauvegardées. Le recyclage doit être dans un try/catch (ne pas perdre les ads
  sur une erreur de contexte Playwright).
- **Renderer canvas null** : `renderCharts` doit vérifier l'existence des canvas
  (`priceDistChart`, `sellerChart`, `topCitiesChart`) avant `getContext('2d')`.
  Sans cela, un canvas absent faisait crasher `renderStatsView` ET `renderMap`
  (appelée après) — la carte entière disparaissait.
- **Renderer localStorage JSON** : `JSON.parse(cached)` sur un cache géocodage
  doit être dans un try/catch. Un cache corrompu (donnée non-JSON) faisait crasher
  tout le rendu de carte. En cas d'échec, `localStorage.removeItem` pour purger.
- **constants.js DEFAULTS mort** : l'ancien bloc `DEFAULTS` (minDelay/maxDelay/
  headless:false) était mort ET conflictuel avec `SETTINGS_DEFAULTS` (settings.js,
  headless:true). Supprimé. Les valeurs par défaut des réglages vivent dans
  `core/settings.js` UNIQUEMENT.

## Pièges corrigés (audit 2026-08, 3e passe — cohérence UI/docs/logique)
- **Format date historique** : `jobHistory.js` ne doit PAS remplacer tous les `-`
  par `:` dans le nom du dossier job-<ISO> → cela produisait « 2026:08:12 à 02:21 »
  (deux-points dans la date, illisible). Utiliser un regex pour extraire les
  composants et formater en `JJ/MM/AAAA à HH:MM`.
- **rapport.txt mort** : `jobHistory.js` vérifiait l'existence d'un `rapport.txt`
  que le pipeline ne crée JAMAIS. Retiré (chemin + champ `files.rapport`).
- **Preset searchProvider** : `collectSearchConfig` doit capturer le moteur de
  recherche (DuckDuckGo/Tavily) et `applySearchConfig` doit le restaurer + déclencher
  l'événement `change` (pour masquer/afficher le champ clé API). Sans cela, un preset
  sauvegardé avec Tavily se rechargeait en DuckDuckGo.
- **IA Marché en mode hors-ligne** : `triggerMarketBtn` doit vérifier `isOffline`
  avant de lancer (DuckDuckGo nécessite Internet). Sans ce garde, un batch complet
  tombait en fallback inutile (0/N réussies) avec un message confus.
- **FAQ/help incohérents** : la FAQ/help ne doivent PAS mentionner de contrôles UI
  supprimés (checkbox « Analyser les images par IA Vision » → la vision est désormais
  automatique si modèle + photos). Ne pas dire « Décochée par défaut » pour
  `autoAiMarket` (elle est cochée). Ne pas mentionner la vitesse « Ultra » (non
  exposée dans le select — seuls Rapide/Équilibré/Prudent le sont). La doc doit
  refléter l'UI réelle, pas une version antérieure.

## Code mort retiré
- `runWithConcurrency` et `formatDuration` (utils/helpers.js) n'étaient utilisés
  nulle part (les batchs IA utilisent leur propre queue de workers).
- `rapport.txt` (jobHistory.js) : chemin + champ `files.rapport` vérifiaient un
  fichier que le pipeline ne crée jamais. Retiré.
- `DEFAULTS` (constants.js) : bloc mort conflictuel avec `SETTINGS_DEFAULTS`.
- `risk-keywords.js` (config/) : jamais importé dans l'app, seulement référencé
  par les tests. Supprimé (4e passe).

## Pièges corrigés (audit 2026-08, 4e passe — fiabilité écriture/offline)
- **Écritures atomiques pour fichiers critiques** : `secretStore._save()`,
  `settings.saveSettings()` et `aiCache._saveNow()` utilisaient
  `fs.writeFileSync` (non-atomique). Un crash pendant l'écriture corrompait
  le fichier → TOUS les secrets/réglages/cache IA perdus au redémarrage.
  Maintenant : `atomicWriteFileSync` (tmp + rename) partout, comme
  `writeWithChecksum` pour les annonces.
- **Guard offline IA Marché** : `triggerMarketBtn` ne bloquait que
  `duckduckgo` en mode hors-ligne — Tavily aussi nécessite Internet.
  La guard s'applique maintenant à TOUS les providers.
- **Refresh après suppression job** : `askDeleteJob` ne rafraîchissait pas
  l'explorateur/stats/sessionSelect → données fantômes dans l'UI.
- **compareSet stale** : les IDs d'annonces supprimées restaient dans
  compareSet → count désynchronisé. Nettoyage au changement de cache.

## Sécurité (déjà en place)
- Renderer sandboxé (sandbox:true, contextIsolation:true, nodeIntegration:false)
- `shell:openExternal` filtré (http/https uniquement)
- `file:openFolder/openFile` validés contre BASE_OUT_DIR (anti path-traversal)
- Clés API via `safeStorage` (secretStore.js), pas en clair
- Clé API recherche via secretStore (4e passe), pas en clair localStorage
- **XSS attribut HTML (4e passe)** : `escapePath()` échappe désormais `"` → `&quot;`
  et `&` → `&amp;` en plus de `\` et `'`. Les données scrapées (URLs, images,
  a.id) injectées dans des attributs HTML (`src=`, `onclick=`) sont maintenant
  échappées via `escapeHtml()` (src) ou `escapePath()` (onclick double-contexte
  HTML+JS). `escapeHtml` ne convient PAS pour `onclick="func('...')"` car le
  navigateur décode `&#39;` en `'` avant d'exécuter le JS → casserait la chaîne.
- **Hardening webview (4e passe)** : handler `will-attach-webview` sur
  `web-contents-created` — verrouille `nodeIntegration:false`,
  `contextIsolation:true`, `sandbox:true`, supprime tout preload injecté,
  isole la session. Empêche un renderer compromis de créer un `<webview>`
  avec des webpreferences permissives.

## Commandes
- Lancer l'app : `npm start` (electron --max-old-space-size=8192 .)
- Tests : `npm test` (ou `node test/regression.test.js`) — 504 assertions
- Branche stable : `refactor/professional-architecture`
