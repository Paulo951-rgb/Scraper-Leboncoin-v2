# AGENTS.md — Vendra

Repository knowledge for AI agents working on this codebase.

## Stack
- Electron 44 (main + renderer, contextIsolation + sandbox)
- Node.js main process, Playwright 1.64 (Chromium) pour le scraping
- electron-builder 26 pour la génération du `.exe` (NSIS + portable)
- **Aucune IA** : pas d'Ollama, pas de LLM, pas de vision, pas de cloud. L'app est 100% locale.
- **Aucune dépendance Excel** : pas d'ExcelJS, pas d'export XLSX/CSV. Seuls JSON et TXT sont générés.

## Architecture SCRAPING → EXPORTS
```
SCRAPER (harCapturer + pipeline) → DONNÉES SCRAPÉES → EXPORTS (JSON/TXT)
```

Le scraping fonctionne **100% sans IA**. Il n'y a aucun système d'IA dans le projet. Toutes les opérations sont déterministes : extraction, normalisation, calcul du `deliveryType`, statistiques, exports.

`adFields.js` est un module de **scraping pur** : aucun appel IA, aucun prompt, aucun LLM, aucun fetch externe.

## Champ `deliveryType` (unifié)

L'ancienne paire de champs `livraison` / `mainPropre` a été remplacée par un **champ unique** `deliveryType` calculé par `computeDeliveryType(livraison, mainPropre)` dans `adFields.js` :

| Valeur | Condition |
|---|---|
| `les_deux` | `livraison === true && mainPropre === true` |
| `livraison` | `livraison === true && (mainPropre === false \|\| mainPropre === null)` |
| `main_propre` | `(livraison === false \|\| livraison === null) && mainPropre === true` |
| `aucun` | `livraison === false && mainPropre === false` (ou l'un false et l'autre null) |
| `inconnu` | `livraison === null && mainPropre === null` |

Les deux booléens internes (`livraison`, `mainPropre`) sont toujours extraits séparément par `extractTransaction(raw)` puis unifiés en `deliveryType`. Les anciens champs `livraison` et `mainPropre` ne sont plus exposés dans le modèle de données final — seul `deliveryType` figure dans `annonces.json`.

## Profils de données (3 profils)

`src/main/services/exporting/dataProfiles.js` définit 3 profils :

| Profil | ID | Description | Champs |
|---|---|---|---|
| **Défaut** | `default` | Scraping rapide et léger | 13 champs essentiels (DEFAULT_PROFILE_FIELDS) |
| **Maximum** | `maximum` | Toutes les données disponibles | ALL_FIELD_KEYS (~23 champs) |
| **Personnalisé** | `custom` | Choix de l'utilisateur | Stocké en localStorage côté renderer, transmis au main process |

`getProfileFields(profileId, customFields)` renvoie la liste des clés à conserver. En mode Personnalisé, les clés sont filtrées contre `ALL_FIELD_KEYS` (validation côté main process).

## Codes d'erreurs structurés

`src/main/services/scraping/errorCodes.js` définit un système de codes d'erreurs préfixés par domaine :

- `NET_*` — erreurs réseau (timeout, DNS, connexion)
- `HTTP_*` — erreurs HTTP (403, 429, 404, 500, inconnu)
- `HTTP_ACCESS_REFUSED` — HTTP 403 : accès refusé par le serveur
- `HTTP_RATE_LIMITED` — HTTP 429 : limitation de débit (Retry-After respecté)
- `ACCESS_UNVERIFIED` — session non validée (accès impossible à confirmer)
- `CAPTCHA_*` — captcha (détecté, timeout, non résolu, non confirmé)
- `PARSE_*` — parsing (HAR invalide, JSON invalide, aucune annonce)
- `EXTRACTOR_*` — extracteurs (vendeur, prix, description, localisation, dates, photos)
- `SESSION_*` — session (expirée, invalide)
- `BROWSER_*` — navigateur (crash, fermé, échec lancement)
- `STRUCTURE_*` — structure (changée, champ manquant)
- `AD_*` — annonce (supprimée, modifiée, vide)

`createError(code, message, context)` crée un objet d'erreur structuré `{ code, message, context, timestamp }`.

`classifyError(code)` catégorise l'erreur pour déterminer l'action : `recoverable`, `ad_error`, `network_error`, `session_error`, `global_error`, `unknown`.

## Vérification d'accès (anti-fausse-réussite)

La vérification d'accès est assurée par `_warmupSession` (harCapturer) : elle
juge sur des signaux OBJECTIFS et JAMAIS sur la seule disparition visuelle du
défi CAPTCHA.

- Statut HTTP de la navigation de pré-check (`warmupStatus`) : `>= 400` (403/429)
  → blocage détecté même sans CAPTCHA visible.
- `_checkCaptcha(page)` : détection content-based (iframes Arkose/hCaptcha/
  reCaptcha/Cloudflare, éléments DOM `#challenge-form`/`.cf-turnstile`, URL
  `/captcha`|`/challenge`).
- `latestHttpStatus` : écouteur de réponse dynamique pour suivre un 403/429
  après redirection.
- Confirmation 2 s (double re-vérification) avant de déclarer la résolution,
  pour éviter les faux positifs de transition.
- Après résolution : stabilisation (`networkidle` + 1,5 s) puis re-vérification
  finale (2e CAPTCHA consécutif → session NON persistée).

`_warmupSession` renvoie `{ verified, reason }`. La session n'est persistée QUE
si `verified === true`. Historiquement, une fonction `_verifyAccess()` (requête
document HEAD/GET) avait été ajoutée puis **retirée** (son filtre de contenu
rejetait à tort des réponses valides — cf. `[30]` « moteur historique restauré »).
Ne pas la réintroduire ni documenter son existence : les tests `[30]` asservissent
son ABSENCE (`!/_verifyAccess/`).

États de statut envoyés au renderer : `capturing`, `processing`, `completed`,
`partial` (succès partiel : enrichissement bloqué 403/429 ou interruption),
`cancelled`, `error`, `refused` (403), `rate_limited` (429).

Codes de sortie du pipeline (contrat avec `pipelineRunner.js`) : `0` succès,
`1` erreur fatale, `2` aucune donnée exploitable, `3` enrichissement arrêté sur
HTTP 403, `4` enrichissement arrêté sur HTTP 429.

## Politique de scraping FIXE (non configurable) — source unique

`src/main/config/scraping.js` → `SCRAPING_POLICY` (figé via `Object.freeze`) est
la **seule** source de vérité pour la performance de scraping. L'utilisateur ne
peut plus la modifier : elle est appliquée automatiquement au démarrage par
toutes les couches.

- `SCRAPING_POLICY = { mode: 'ultra-rapide', label: 'ULTRA RAPIDE',
  concurrency: 25, pageDelayMs: 400, enrichMinDelayMs: 400, enrichMaxDelayMs: 8000 }`.
- `getScrapingPolicy()` renvoie une copie ; `clampConcurrency(n)` borne toute
  concurrence demandée à `MAX_CONCURRENCY` (25) — un renderer compromis ou un
  ancien paramètre persisté ne peut JAMAIS relever le débit.
- `harCapturer` et `leboncoin-pipeline` consomment la politique directement.
  Le pipeline force `opts.concurrency = clampConcurrency(policy.concurrency)`,
  `opts.minDelayMs`/`opts.maxDelayMs` depuis la politique, et ignore tout
  `--speed` hérité (`opts.speed = policy.mode`).
- **UI** : plus aucun contrôle modifiable de vitesse/délai. `index.html` affiche
  le mode en lecture seule (`.scraping-mode-readonly`). `scraperModule.js` ne
  lit/écrit plus `scrapeSpeed`/`pageDelayMs`.
- **Migration** : `settings.migrateSettings(raw)` retire les clés héritées
  (`scrapeSpeed`, `pageDelayMs`) à la lecture ; `sanitizeSettingsPatch` les
  rejette à l'écriture. Un ancien `user-settings.json` ne peut donc pas rétablir
  une configuration contradictoire.
- **Invariants testés** : `test/regression.test.js` section `[41]`.
- Les anciens `SPEED_PRESETS` / `getSpeedPreset()` sont conservés uniquement pour
  la rétro-compatibilité d'affichage : `getSpeedPreset()` renvoie toujours la
  politique fixe, quelle que soit la valeur demandée.

## Anti-débit (rate limiting) — ne PAS réintroduire la régression

`AdaptiveRateLimiter` (`src/main/utils/rateLimiter.js`) utilise `baseDelayMs`
comme délai **MINIMAL** (`minDelayMs` par défaut = `baseDelayMs`). Il est
instancié par `DescriptionEnricher` avec `baseDelayMs = opts.minDelayMs` (dérivé
de la politique) et `maxDelayMs = opts.maxDelayMs`. Conséquence : **si les
délais de base sont trop faibles, le backoff après blocage est lui aussi
minuscule** (ex. base 50 ms → backoff max 250 ms), ce qui ne freine rien face à
une limitation de débit. C'est pourquoi `enrichMinDelayMs = 400` (jamais 50).

- Délais issus de la politique : `minDelayMs = 400`, `maxDelayMs = 8000`.
- Le backoff saute directement à `base × 2^max(N,4)` (×16) dès le premier
  blocage — cf. commit de diagnostic 403.
- Réduction adaptative de la concurrence (`nextConcurrencyAfterBlock`) : ÷2 après
  un 429, −25 % après un 403, jamais sous 1, jamais en hausse.
- `Retry-After` (429) est appliqué comme **pause inter-batch**
  `max(délai adaptatif, Retry-After)` : aucune reprise avant le délai indiqué.
- Le commit `a861165` (« restore fast parallel scraping ») avait remonté la
  concurrence à 25 et baissé les délais à 50 ms → **régression de débit** à ne
  pas reproduire. Le délai de 400 ms est NOMINAL : il n'autorise pas à ignorer
  une limitation explicite du site.

## Fiabilité : signaux structurés, reprise, anti-boucles

- **Arrêt d'enrichissement structuré** : `CircuitBreaker` (machine
  `normal → slowed → blocked → stopped`) remplace les compteurs dispersés. Au
  seuil `BLOCK_THRESHOLD` (config/scraping.js) de blocages CONSÉCUTIFS, le
  pipeline émet une ligne machine-lisible
  `[STOP_REASON] code=… status=… reason=… consecutiveBlocks=…` puis sort en
  code `3` (403) / `4` (429). `ipcHandlers` détecte ce signal — **ne PAS
  revenir aux heuristiques de texte** (`msg.includes('interrompu') ||
  msg.includes('restreint')`) qui déclenchaient des faux « succès partiels »
  sur les messages de détection CAPTCHA.
- **Journal réseau** : `NetworkJournal` compte navigations / requêtes détail /
  403-429 (avec URLs) / erreurs ; `harCapturer` émet `[NET_JOURNAL] …` et le
  pipeline écrit `report.json` (durées par phase + circuit + journal + mesures de
  performance `totalMs`/`adsPerMinute`/`avgMsPerAd`/`peakRssMb`) dans
  `<jobDir>/results/`.
- **Reprise incrémentale** : `harCapturer` persiste `capture-progress.json`
  (`lastPageOk`) après chaque page réussie ; en reprise il écrit un HAR séparé
  puis le fusionne (`captureState.mergeHarFiles`) — un blocage page 7/10 ne perd
  plus les pages 1-6. Option `resumeFrom` + auto-reprise depuis le fichier.
- **Anti-boucles** : le pré-check CAPTCHA renvoie `{ verified }` ; si l'accès
  n'est PAS validé on ARRÊTE (plus de fenêtres CAPTCHA en boucle). Garde-fou de
  pagination (signature de page déjà vue) et détection de page 200 vide
  (`_looksLikeEmptyResults` → soft-block).
- **Config partagée** : `src/main/config/scraping.js` (presets, seuils, états,
  `MAX_PAGES`) et `sessionPaths.js` n'importent PAS `electron` → importables par
  le pipeline forké. Le main transmet `--base-out-dir` au fork.

## Compteurs de session (résumé) — motifs exacts

`ipcHandlers` compte via les lignes du pipeline. Motifs à respecter si les
libellés changent :

- Annonces extraites : `/(\d+)\s+annonces?\s+extraites?/i` (ligne
  « Étape HAR -> Annonces terminée : N annonces extraites. ») ET
  `/(\d+)\s+unique\(s\)\s+en\s+sortie/i` (ligne `[METRICS]`).
- Doublons : `/(\d+)\s+doublon/i`, cumulés en `Math.max` (idempotent).
- L'ancien motif `annonce\(s\)\s+(?:unique|extrait)` ne matchait PAS la ligne
  réelle (mot au singulier) → `adsFound` restait à 0 (« 236 extraites / 0
  trouvée »). Ne pas y revenir sans vérifier la ligne émise.

## Champs d'annonce (schéma scraping pur)

Structure produite par `normalizeAd()` (sans aucune dépendance IA) :

| Section | Champs | Notes |
|---------|--------|-------|
| GÉNÉRAL | id, title, url, category | |
| PRIX | prix (nombre) | `prix` est un nombre, PAS un objet |
| LOCALISATION | city, zipcode | |
| TRANSACTION | deliveryType | Champ unifié (les_deux / livraison / main_propre / aucun / inconnu) |
| VENDEUR | vendeurNom, vendeurType, vendeurId, vendeurNote, nombreAvis, vendeurUrlProfil | note=null si pas dispo ; `vendeurAncienneteJours` extrait en interne mais NON exporté/affiché |
| STATS | likes | 0 ≠ null |
| DATES | datePublication, dateScraping | scraping=ISO au moment de l'extraction ; `dateModification` retiré des exports/UI |
| PRODUIT | etat | État déclaré UNIQUEMENT (extrait des attributs structurés) |
| PHOTOS | photosCount, photosUrls | |
| DESCRIPTION | description | Toujours une string (jamais un objet) |

**Convention** : tout champ non trouvé est `null` (jamais `0`, jamais `''`, jamais une valeur inventée).

**Champs SUPPRIMÉS (ne doivent plus apparaître nulle part)** : `livraison`, `mainPropre` (remplacés par `deliveryType`), `negociable`, `facture`, `garantie`, `echangeAccepte`, `urgent`, `vues`, `marque`, `modele`, `couleur`, `taille`, `capacite`, `annee`, `matiere`, `reference`, `etatDetecte`, `etatInferre`, `detection{}`, `prix.valeur` (remplacé par prix simple), `prix.devise` séparé, `prix.original`, `prix.negociable`, `adAnalysis` (IA supprimée), `marketAnalysis` (IA supprimée), `vision` (IA supprimée), `vendeurAnciennete` (clé d'export retirée), `dateModification` (clé d'export retirée).

## Architecture (src/main/)
```
main.js                      cycle de vie Electron, fenêtres, single-instance lock, webview lock
preload.js                   pont sécurisé Main ↔ Renderer (contextBridge)
widgetPreload.js             preload dédié au widget flottant
core/ipcHandlers.js          TOUS les handlers IPC (job, fichiers, secrets, config)
core/settings.js             persistance user-settings.json
config/constants.js          BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH, THEMES (require electron/app)
config/scraping.js           presets de vitesse + seuils + états disjoncteur (SANS electron,
                             importable par le pipeline forké) — source unique partagée
services/scraping/           harCapturer (Playwright) + pipelineRunner (fork) + leboncoin-pipeline
                             + adFields.js (extracteurs centralisés — SCRAPING PUR)
                             + errorCodes.js (codes d'erreurs structurés)
                             + userAgents.js (10 UA réalistes)
                             + circuitBreaker.js (disjoncteur normal→slowed→blocked→stopped)
                             + networkJournal.js (compteurs réseau objectifs par job)
                             + captureState.js (progression par page + fusion HAR, reprise)
                             + sessionPaths.js (résolution centralisée des sessions)
services/exporting/          exportFields.js (champs exportables + filtrage + TXT lisible)
                             dataProfiles.js (3 profils : Défaut/Maximum/Personnalisé)
services/analysis/adStats.js statistiques de prix brutes (sans scoring)
services/jobs/jobHistory.js  listing/lecture/suppression jobs, buildAdHistory
services/maintenance/storageCleaner
infrastructure/              fileManager (ouverture fichiers/dossiers)
utils/                       helpers, diagnostics, integrity, rateLimiter, logger, secretStore, urlSecurity
```

## Architecture (src/renderer/)
```
index.html                   UI (sidebar, onglets, modales)
widget.html                  widget flottant
app.js                       orchestration, sidebar, routage
appState.js                  état global du renderer
utils.js                     escapeHtml, escapePath, formatage
scraperModule.js             onglet Scraper (URL, pages, profil, presets, options ;
                             mode de performance fixe affiché en lecture seule)
logsModule.js                onglet Logs (console temps réel, filtrage)
historyModule.js            onglet Historique (jobs, ouverture, suppression)
explorerModule.js           onglet Explorateur (table, grille, filtres, tri, fiche)
statsModule.js               onglet Statistiques (cartes + 4 graphiques, sessions sélectionnables)
mapModule.js                 onglet Carte (Leaflet, géocodage API Gouv, clusters, marqueurs)
helpModule.js               module d'aide (FAQ, guide, feedback)
styles.css                   habillage + 3 thèmes (Sombre/Clair/Graphite) + composants
```

> **Note** : l'ancien répertoire `services/ai/` (adAnalyzer, marketValueAnalyzer, promptGenerator, promptTemplates, aiCache, ollamaHealth, providers/, search/) a été **entièrement supprimé**. L'ancien module `aiStudioModule.js` (renderer) a été supprimé. L'ancien `excelExporter.js` (infrastructure) a été supprimé.

## Conventions clés
- Les handlers IPC sont enregistrés UNE SEULE FOIS (dans app.whenReady) via
  `setupIpcHandlers(getMainWindow)`. Le getter `getMainWindow()` renvoie null si
  la fenêtre est détruite — ne JAMAIS capturer `mainWindow` par closure.
- `sendLog/sendProgress/sendStatus` (ipcHandlers) utilisent `getWin()` qui garde
  contre les fenêtres détruites. Ne pas remettre d'appels directs `mainWindow.webContents.send`.
- **Onglet Logs (renderer)** : buffer mémoire `_logBuffer` (MAX 3000) + filtrage
  rétroactif par mode (normal=info/warn/error, debug=tout). Auto-scroll ON par
  défaut. `sendSessionSummary()` en fin de job envoie un résumé formaté.
- Écriture JSON avec intégrité : `writeWithChecksum(path, data, replacer, space)`
  (src/main/utils/integrity.js). NE PAS utiliser `fs.writeFileSync` pour les
  fichiers d'annonces — cela casse la validation SHA-256.
- Fetch natif Node.js : PAS d'option `timeout`. Utiliser AbortController + setTimeout
  pour tous les fetch (sinon requête bloquée indéfiniment).
- `constants.js` et `logger.js` et `secretStore.js` require('electron') au
  top-level → NE JAMAIS les require depuis le pipeline sous-processus (fork), qui
  n'a pas accès à `app`.


## Identité « Vendra » et dossier de données (migration)
- Nom produit : **Vendra** (`APP_NAME`, `productName`, `appId: com.vendra.app`).
  Cohérence exigée entre `package.json`, la fenêtre, l'installeur et les raccourcis.
- Dossier de données packagé : `Documents/Vendra` (dev : `./output`). La migration
  depuis l'ancien dossier `Documents/Leboncoin Scraper Pro` est faite par
  `resolvePackagedBaseDir()` (`config/constants.js`) via un `rename` atomique —
  AUCUNE copie, AUCUNE suppression. Si le rename échoue (dossier verrouillé), on
  continue d'utiliser l'ancien emplacement : la compatibilité prime. `BASE_OUT_DIR`
  est la source unique (jobs, secrets, logs) pour qu'un renommage ne laisse pas de
  secrets orphelins.

## Récupération des photos dans TOUS les profils (règle centralisée)
- Les URL de photos (`photosUrls`) sont un champ TECHNIQUE essentiel à
  l'explorateur (vignettes + galerie) : elles ne doivent JAMAIS dépendre du profil.
- `ESSENTIAL_FIELD_KEYS` + `ensureEssentialFields(fields)` (`exporting/exportFields.js`)
  garantissent `photosCount`/`photosUrls` dans Défaut, Maximum ET Personnalisé.
  `getProfileFields` (dataProfiles) et `filterAdByFields`/`toReadableBlock` appliquent
  la règle → ne pas revenir à un filtrage sec qui laisserait les photos disparaître.
- Les images sont chargées à la DEMANDE depuis leur URL distante (`loading="lazy"`,
  `decoding="async"`) : aucun téléchargement massif sur disque, aucun cache disque.
- États visuels gérés : chargement (`.img-loading`), erreur/URL expirée
  (`.img-error` → placeholder local), aucune image (placeholder). Ne jamais
  substituer de données fictives.

## Localisation : compatibilité des clés (ville/city, codePostal/zipcode)
- Le modèle `normalizeAd` expose `city`/`zipcode` ; les clés d'EXPORT sont
  `ville`/`codePostal`. `filterAdByFields` traduit via `MODEL_KEY_FOR_EXPORT`.
- Côté renderer, `cityOf(a)` / `zipOf(a)` / `locationLabel(a)` (`utils.js`, chargés
  avant les modules) résolvent `city ?? ville ?? location.city` (et l'inverse pour le
  code postal). Sans cela, l'explorateur et la fiche détaillée affichaient
  « Inconnue » alors que la ville existait. `locationLabel` n'invente JAMAIS de ville :
  absence → « Inconnue ».

## Onglets Statistiques et Carte (séparés)
- `statsModule.js` = cartes + 4 graphiques uniquement (plus de carte). Sélection de
  sessions (`statsSessionSelect`) ; les prix/villes inconnus ne sont PAS comptés
  comme zéro ; médiane correcte pour un nombre pair de valeurs.
- `mapModule.js` = onglet **Carte** indépendant : Leaflet plein écran, `map.invalidateSize()`
  à l'ouverture de l'onglet (sinon carte grise), filtres session + remise main propre,
  clusters (`clusterMarkers`), bouton de recentrage, marqueurs cliquables (fiche + annonce).
  Géocodage API Gouv France, cache localStorage BORNÉ (`GEO_CACHE_MAX`), timeout 10 s.
  Aucune coordonnée inventée : ville géocodée → position au centre de la ville.

## Historique : ouverture du dossier de résultats
- Chaque session expose une action « Ouvrir le dossier » (`openSessionFolder(jobId)`).
- Le renderer ne fournit JAMAIS de chemin : seul un identifiant `job-<...>` est
  transmis, validé côté main (`job:openSessionFolder`), puis le chemin est
  reconstruit et vérifié sous `JOBS_DIR` (anti path-traversal). Cible :
  `<JOBS_DIR>/<jobId>/results`, à défaut le dossier du job. Dossier absent →
  message explicite (jamais d'ouverture silencieuse ratée).

## Bornes anti-DoS de l'historique d'annonces
- `buildAdHistory` borne l'entrée (`MAX_JOBS`, `MAX_ADS_PER_JOB`) et les occurrences
  par annonce (`MAX_OCCURRENCES_PER_AD`) : un `annonces.json` énorme/corrompu ne doit
  pas faire exploser la mémoire du main process.

## Tests
- `node test/regression.test.js` → suite de non-régression (syntaxe + stubs Electron).
  Sections : logique métier, rendu, sécurité, `[27]` carte (logique pure), `[28]` distribution/packaging,
  `[29]` CI Windows (workflow + `verify-dist.js`), `[46]` fiche détaillée (openAdDetail),
  `[47]` pagination explorateur (DOM borné + navigation), `[48]` `sanitizeImageUrl` (anti-SSRF renderer),
  `[49]` audit intégral 2026-10-17 (prix FR, centroïde carte, verrou `job:start`, contamination détail),
  `[50]` audit 2e passe 2026-10-17 (SSRF renderer IPv4-mappée, HAR de reprise CAPTCHA, prix FR
  historique/explorateur, annulation ≠ 403, réglages appliqués immédiatement).
- Le test stub `electron` : BrowserWindow a `webContents.send` mais PAS `isDestroyed`.
- Avant tout commit : `node --check` sur les fichiers modifiés + lancer la suite.

## Intégration continue (GitHub Actions)
- `.github/workflows/build-windows.yml` — runner **windows-latest**, Node 20.
  - Déclencheurs : `push` (main), `pull_request`, `workflow_dispatch`, tags `v*`.
  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'` + `npm run browsers:win` → un seul
    Chromium (Windows), embarqué par `extraResources`.
  - `npm run dist` puis **`node tools/verify-dist.js --dir=dist`** : le build
    échoue si l'installeur, `ffmpeg.dll`, `app.asar` ou le Chromium embarqué
    manquent (garde-fou anti-« installeur tronqué »).
  - Artefact `windows-installer` (build de test) puis, **uniquement sur tag**,
    job `release` (perms `contents: write`) qui publie une Release GitHub avec
    `*.exe` + `*.sha256`.
- **Pour publier une version** : `git tag vX.Y.Z && git push origin vX.Y.Z`
  (voir README §Publication). Aucun jeton dans le dépôt (GITHUB_TOKEN auto).

## Distribution Windows (NSIS + portable)
- Cibles : NSIS x64 + portable x64 (`package.json` → `build.win.target`).
- NSIS : `oneClick:false`, `perMachine:false` (**installation par utilisateur,
  sans admin**), `allowElevation:true`, `createDesktopShortcut` +
  `createStartMenuShortcut`, `deleteAppDataOnUninstall:false`.
- `npmRebuild:false` : pas de module natif, on évite un rebuild inutile (piste
  de fiabilité du build Windows).
- L'erreur historique `Error: spawn UNKNOWN` provient de
  `NsisTarget.computeScriptAndSignUninstaller` → `execWine(installerPath,…)`,
  au moment d'exécuter l'installeur **très volumineux** pour extraire le
  désinstalleur. Contournement : builder nativement sur **Windows** (spec).

## Sécurité (en place)
- Renderer sandboxé (sandbox:true, contextIsolation:true, nodeIntegration:false)
- `shell:openExternal` filtré (http/https uniquement) — `urlSecurity.js`
- `file:openFolder/openFile` validés contre BASE_OUT_DIR (anti path-traversal)
- Clés API via `safeStorage` (secretStore.js), pas en clair
- **XSS attribut HTML** : `escapePath()` échappe `"` → `&quot;` et `&` → `&amp;`
  en plus de `\` et `'`. Les données scrapées (URLs, images, a.id) injectées dans
  des attributs HTML (`src=`, `onclick=`) sont échappées via `escapeHtml()` (src)
  ou `escapePath()` (onclick double-contexte HTML+JS).
- **Hardening webview** : handler `will-attach-webview` sur `web-contents-created`
  — verrouille `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`,
  supprime tout preload injecté, isole la session.
- **Single-instance lock** : empêche plusieurs instances concurrentes.
- **Intégrité des données** : checksum SHA-256, écriture atomique (`.tmp` + `rename`).

## Commandes
- Lancer l'app : `npm start` (electron --max-old-space-size=8192 .)
- Tests : `npm test` (ou `node test/regression.test.js`)
- Navigateur Playwright : `npm run browsers` (hôte) / `npm run browsers:win` (Windows)
- Icône : `npm run icon` (régénère `build/icon.ico` depuis `tools/generate-icon.py`, nécessite Pillow)
- Build .exe : `npm run dist` (electron-builder --win) → NSIS + portable dans `dist/`
- Packaging local : `npm run pack` (electron-builder --dir)
- Vérifier un build : `node tools/verify-dist.js --dir=dist` (échoue si incomplet, écrit les `.sha256`)
- Publier une version : créer/pousser un tag `vX.Y.Z` (le workflow s'en charge)

## Build (electron-builder)
Configuration dans `package.json` → clé `build` :
- **Cible** : Windows x64 (NSIS + portable).
- **Chromium embarqué** : `extraResources` copie `node_modules/playwright-core/.local-browsers` dans `browsers/`.
- **Fichiers inclus** : `src/**/*`, `package.json`, `node_modules/playwright*/**/*`.
- **Icône** : `build/icon.ico` (multi-résolutions 16→256, généré par `tools/generate-icon.py`).
- **NSIS** : `oneClick: false`, `allowToChangeInstallationDirectory: true`, raccourcis bureau + menu démarrer.
- **Portable** : `Leboncoin-Scraper-Pro-Portable-${version}.exe`.
- Au runtime, `main.js` pointe `PLAYWRIGHT_BROWSERS_PATH` vers `process.resourcesPath/browsers` si l'app est packagée.

## Tools (tools/)
- `prepare-browsers.js` : télécharge le Chromium **de la plateforme cible** dans
  `node_modules/playwright-core/.local-browsers/`. Indispensable en build croisé
  (Linux → Windows) : `--platform=win` récupère `chromium-win64.zip` ; sans cela,
  l'exe embarqué contiendrait un Chromium Linux et le scraping planterait.
  Appelé par les hooks `prepack`/`predist`/`prebuild`. Idempotent.
  **Piège** : les archives Playwright s'appellent `chromium-win64.zip` /
  `chromium-mac.zip` / `chromium-linux.zip` (PAS `chromium-win.zip`), et le
  sous-dossier extrait est `chrome-win` / `chrome-mac` / `chrome-linux`.
  **Piège** : la décompression utilise `extract-zip`, qui doit rester déclarée
  explicitement (elle n'était que transitive sous Playwright 1.41 ; sa montée à
  1.64 l'a retirée → CI Windows en échec). Ne jamais dépendre d'une transitive
  pour l'outillage de build (test `[28]`).
- `generate-icon.py` : génère `build/icon.ico` + `build/icon.png` (Pillow).
- `verify-dist.js` : contrôle un dossier `dist/` après build (installeur NSIS,
  `win-unpacked/` + `app.asar` + `ffmpeg.dll`, Chromium embarqué, en-tête PE,
  taille minimale). Écrit les `.sha256`. Échoue (code 1) si un contrôle bloquant
  échoue. Utilisé par la CI avant tout artefact/Release.

## Build croisé Windows depuis Linux
`electron-builder --win` sous Linux exige **Wine** (édition des ressources de
l'.exe via `rcedit`) ET un affichage (Xvfb) — sinon rcedit échoue avec
`XDG_RUNTIME_DIR is invalid` / `could not load kernel32.dll`. Séquera validée :
```bash
sudo dpkg --add-architecture i386 && sudo apt-get install -y wine wine64 wine32:i386 xvfb
export WINEPREFIX=/tmp/wineprefix WINEARCH=win64 XDG_RUNTIME_DIR=/tmp/runtime-openhands
xvfb-run -a npm run dist
```
Sans Wine, `-c.win.signAndEditExecutable=false` permet de produire `dist/win-unpacked`
(dossier app lançable) mais PAS l'installeur ni le portable.

## Pièges corrigés (à ne PAS réintroduire)
- **`recordHar` réutilisé = HAR tronqué (audit 2026-10-17, 2e passe)** : un
  nouveau contexte Playwright avec le MÊME chemin `recordHar` **écrase** le
  fichier (les entrées précédentes sont perdues). La reprise après CAPTCHA
  (`harCapturer`) écrivait dans `activeHarPath` → les pages capturées avant le
  blocage disparaissaient. Écrire dans un HAR dédié (`capture-retry.har`) puis
  **fusionner** (`mergeHarFiles`) dans le HAR principal, comme la reprise
  incrémentale (`capture-resume.har`). Test `[50]`.
- **Prix en chaîne FR dans le renderer/historique (audit 2026-10-17, 2e passe)** :
  `parseFloat('1 250 €')` → `1`. Le pipeline utilise `parsePriceString` mais
  `jobHistory.buildAdHistory` et l'explorateur (`explorerModule`) utilisaient
  encore `parseFloat` → prix tronqués (baisse/hausse `null`, filtre de prix
  masquant des annonces, tri faux). Utiliser `parsePriceString` (main) et le
  helper renderer `priceOf` (`utils.js`) pour TOUT filtre/tri/affichage de prix.
  Test `[50]`.
- **Annulation ≠ blocage d'accès (audit 2026-10-17, 2e passe)** : le handler
  SIGINT du pipeline forçait `circuit.state = 'stopped'` sans drapeau → `stopInfo()`
  renvoyait `access_refused` (faux 403) et un code de sortie 3 sur une simple
  annulation. Utiliser `circuit.markCancelled()` : `stopInfo()` renvoie `null`
  (aucun motif d'accès), tandis que les vrais 403/429 restent rapportés. Test `[50]`.
- **`sanitizeImageUrl` et IPv4-mappées (audit 2026-10-17, 2e passe)** : les
  formes `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe` (métadonnées cloud), ULA
  (`fc00::/7`), link-local (`fe80::/10`) et NAT64 (`64:ff9b::/96`) NON compressées
  passaient le filtre renderer (SSRF). Décompresser l'IPv6 en groupes 16 bits et
  rejouer le contrôle IPv4 sur les 32 derniers bits. Test `[50]`.
- **Réglages appliqués seulement au redémarrage (audit 2026-10-17, 2e passe)** :
  décocher « Données vendeur » ne masquait pas la colonne Vendeur (rappeler
  `refreshSellerDataSetting()` après `saveConfig`) ; la rétention des logs n'était
  appliquée qu'au démarrage (`config:save` doit appeler `logger.setRetention`).
  Test `[50]`.
- **Prix en chaîne (audit 2026-10-17)** : `extractPrice` (adFields) NE DOIT PAS
  utiliser `parseFloat` seul. `parseFloat('1 250 €')` → `1` et
  `parseFloat('1.299,99')` → `1.299` (troncature silencieuse). Utiliser
  `parsePriceString` (espaces retirés, `.` = milliers, `,` = décimal) — même
  convention que `AdStats` et le renderer. Test `[49]`.
- **`clusterMarkers` : centroïde = moyenne des POINTS** (audit 2026-10-17). Le
  diviser par le nombre d'ANNONCES (`cell.ads.length`) plaçait un marqueur hors
  de la ville (1 ville à 5 annonces → `lat 9,14`). Utiliser un compteur de points
  dédié. Test `[49]`.
- **`job:start` : valider AVANT d'armer le verrou** (audit 2026-10-17).
  `isRunning = true` était posé avant le `try/finally` et `config.pages` lu sans
  garde → une config `undefined` levait hors `finally` et laissait le verrou armé
  pour toujours (tous les jobs suivants ignorés jusqu'au redémarrage). Valider
  `config` (objet) et `searchUrl` (chaîne non vide) AVANT `isRunning = true`.
  Test `[49]`.
- **`parseHtmlDescription` : rapprochement STRICT sur l'ID** (audit 2026-10-17).
  Le repli `exact || found[0]` attribuait description/vendeur/état d'une AUTRE
  annonce quand l'ID demandé était absent (corruption silencieuse, risque de
  données personnelles mal attribuées). Si l'ID est fourni mais introuvable →
  champs `null` ; le repli `found[0]` n'est permis que sans identifiant. Test `[49]`.
- **Diagnostic « images: 0 »** : `summarizeAds` (utils/diagnostics.js) DOIT compter
  `photosUrls` (clé du modèle `normalizeAd`), pas seulement `a.images` (clé des
  objets BRUTS d'avant normalisation). Lire `a.images` affichait « images: 0 »
  sur des annonces dont les photos étaient correctement extraites → faux
  diagnostic de panne. Accepter les deux clés.
- **Pagination de l'explorateur (NE PAS la retirer)** : `renderExplorerAds` DOIT
  ne construire qu'une tranche de `EXPLORER_PAGE_SIZE` (500) lignes via
  `filtered.slice(startIdx, startIdx + PAGE_SIZE)`. Construire TOUTES les lignes
  d'un `innerHTML` gelait l'interface ~17 s et créait ~405 000 nœuds DOM sur une
  session de 20 000 annonces (mesuré au harnais CDP ; ~0,5 s et 11 193 nœuds
  après). `explorerPage` revient à 1 à chaque changement de filtre/session.
  Test : `regression.test.js` section `[47]`.
- **Graphiques Chart.js et thème** : ne JAMAIS figer les couleurs des graphiques
  (Tailwind `#38bdf8`/`#8b5cf6`) ni omettre la couleur des ticks (axes noirs sur
  fond sombre). Lire la palette depuis les variables CSS (`--primary-color`,
  `--text-muted`, `--text-color`, `--border-color`) au moment du rendu et
  reconstruire au signal `themechange` (dispatché par scraperModule au changement
  de thème). Libellés SANS emoji (identité = icônes vectorielles).
- **Contraste WCAG thème Clair** : `--primary-color` du thème clair doit rester
  ≤ #256b62 (ratio ≥ 4,5:1 sur `--bg-secondary` pour les en-têtes de tableau de
  12px). #2b7a70 ne donnait que 4,27:1. Vérifier avec un calcul de luminance
  relatif, pas à l'œil.
- **Contrôle anti-SSRF du chemin Playwright (NE PAS le retirer)** : le commit de
  base avait retiré `isSafeFetchDestination`/`_installNetworkGuard` de
  `harCapturer` (« moteur historique »), alors que la documentation
  (`AGENTS.md`, `KNOWN_ISSUES` KI-3, `PHASE2_REPORT`) le déclarait actif. Un
  test de non-régression asserait même son ABSENCE. C'était une **régression de
  sécurité** : l'URL de recherche (entrée utilisateur) pouvait viser
  `http://169.254.169.254/…` (métadonnées cloud), `http://127.0.0.1/…` ou un
  domaine arbitraire (SSRF), et aucune sous-requête n'était filtrée. Restauré :
  validation avant lancement + `_installNetworkGuard` (sous-requêtes) dans
  `harCapturer`, plus le contrôle équivalent dans le `route` handler du pipeline
  d'enrichissement. Les tests `[44]` verrouillent ces invariants.
- **`ctx.route()` + `recordHar`** : vérifier qu'un filtre réseau
  (`ctx.route('**/*')`) n'empêche PAS l'enregistrement du HAR (source des
  données). Testé avec le Chromium embarqué : les deux coexistent, le HAR reste
  rempli. Un `route` handler qui `abort()` la navigation légitime (ex. filtre
  d'images trop large sur le document) casserait la capture.
- **Enrichissement des descriptions** : `DescriptionEnricher.enrichAll` DOIT
  cibler aussi les annonces qui ont déjà une description mais dont un champ de
  détail est manquant (`vendeurNote`, `nombreAvis`, `vendeurUrlProfil`,
  `vendeurAncienneteJours`, `etat`, `livraison`, `mainPropre`). Revenir à
  `a.url && !a.description` saute l'enrichissement dès que la recherche fournit
  un `body` → données vendeur/état/mode de remise uniquement présentes sur la
  page de détail restent `null`.
- **Données de détail** : `parseHtmlDescription` DOIT remonter TOUTES les données
  vendeur du détail (`nombreAvis`, `urlProfil`, `ancienneteJours`, `vendeurNom`,
  `vendeurType`, `vendeurId`), pas seulement `note`. La fusion vers l'annonce
  passe par `applyDetailFields` (fonction pure) qui n'écrase JAMAIS une valeur
  déjà non-nulle et recalcule `deliveryType` dès qu'un booléen de transaction est
  touché.
- **Fusion de doublons** : `mergeKeepingNonNull` DOIT recalculer `deliveryType`
  après fusion de `livraison`/`mainPropre` (deux occurrences peuvent chacune
  fournir un booléen → un unifié périmé affichait `livraison`/`main_propre` au
  lieu de `les_deux`).
- **Navigation onglets** : `app.js` DOIT cibler `[data-tab]` (pas l'ancienne
  classe `.tab-btn`) pour attacher les écouteurs de navigation. La sidebar
  utilise `.nav-item`. Un sélecteur désaligné = onglets totalement morts
  (aucun écouteur posé), sans erreur visible en console.
- **Champs internes d'annonce** : `raw`, `extractionErrors`, `livraison` et
  `mainPropre` sont INTERNES et ne doivent JAMAIS être écrits dans
  `annonces.json`/`annonces.txt`. `writeOutputsFactory` les retire via
  `stripInternalFields` (indispensable en profil Maximum où les annonces sont
  écrites telles quelles). `livraison`/`mainPropre` sont unifiés en
  `deliveryType` : les réexposer viole le modèle documenté.
- **Paramètres renderer** : `config:save` DOIT passer par
  `sanitizeSettingsPatch` (clés connues + type/plage). Fusionner le patch brut
  permettait d'injecter des clés et de régler `autoCleanJobsDays` à une valeur
  énorme → purge massive de jobs au démarrage suivant.
- **`ErrorCodes.UNKNOWN`** : existe et sert de repli dans `pipelineRunner` pour
  les codes de sortie non classés. Ne pas le retirer (sinon logs `[undefined]`).
- **AdStats médiane** : pour un nombre pair de prix, moyenne des deux valeurs
  centrales (le renderer fait pareil dans renderStatsView). Ne pas reprendre
  `validPrices[Math.floor(n/2)]` qui est faux pour les longueurs paires.
- **CAPTCHA détection** : le statut HTTP de la navigation initiale (`vStatus`)
  ne doit JAMAIS être utilisé pour le polling de résolution — il reste figé à
  403 même après résolution. Utiliser `_checkCaptcha(page)` (content-based) +
  `latestHttpStatus` (response listener dynamique) + confirmation 2s anti-faux-positif.
- **Fausse validation d'accès (CAPTCHA)** : la disparition visuelle du défi
  (iframe/texte/URL) NE prouve PAS l'autorisation. `_warmupSession` DOIT
  confirmer sur des signaux objectifs (statut HTTP de navigation `warmupStatus`,
  `_checkCaptcha` content-based, `latestHttpStatus`, confirmation 2 s) avant de
  persister la session et de reprendre. Ne JAMAIS déclarer « CAPTCHA résolu »
  puis lancer la capture si le serveur répond encore 403/429. En cas d'échec :
  arrêt propre, pas de boucle. NB : la fonction `_verifyAccess()` a été retirée
  (filtre de contenu trop large → faux rejets) — ne pas la réintroduire.
- **Boucle de fenêtres CAPTCHA** : la capture ne relance la reprise QUE si
  `_warmupSession` renvoie `verified === true`. Sinon elle `break` (arrêt) — ne
  jamais ré-ouvrir une fenêtre en boucle pour chaque page bloquée.
- **Succès partiel vs succès** : si l'enrichissement est bloqué (403/429) ou si
  des pages sont perdues, `ipcHandlers` DOIT émettre `state: 'partial'` (jamais
  `completed`) et préserver `annonces.json`. Exit codes pipeline `3` (403) / `4`
  (429). Le message de succès n'est affiché QUE si tout est réellement réussi.
- **Pipeline exit code** : une erreur CLI/init doit faire sortir le pipeline en
  code `1` ; « aucune donnée exploitable » (HAR vide, 0 annonce) en code `2` ;
  succès en code `0`. Sinon le PipelineRunner voit 0 et croit que le pipeline a
  réussi, ou confond un run vide avec un crash.
- **Annulation ≠ succès** : `activeCancel.cancelled` doit être LU après la
  capture HAR. Si l'utilisateur a demandé l'arrêt, NE PAS lancer le pipeline
  d'enrichissement et émettre `sendStatus({ state: 'cancelled' })` (état dédié,
  distinct de `completed` et `error`). Le renderer traite `cancelled` comme
  terminal. Sans cela, « Arrêter » affichait « terminé avec succès ».
- **Annulation PENDANT l'enrichissement** : `PipelineRunner.run()` renvoie `130`
  si le pipeline forké a été interrompu. `ipcHandlers` DOIT tester
  `pipelineExit === 130` et lever une erreur `_cancelled` — sinon une annulation
  pendant l'enrichissement était rapportée « terminé avec succès ». Côté
  pipeline, un handler coopératif `process.once('SIGINT')` positionne
  `cancelled=true`/`shouldStopAll=true` pour écrire les résultats partiels et
  fermer le navigateur (handler retiré en `finally`).
- **Sécurité du chemin Playwright (KI-3)** : l'URL de recherche (entrée
  utilisateur) est validée par `isSafeFetchDestination(searchUrl, LEBONCOIN_SOURCE_HOSTS)`
  AVANT de lancer Chromium (`harCapturer.capture()`). Toutes les sous-requêtes
  passent par `_installNetworkGuard` (`ctx.route('**/*')`) qui bloque IP
  privées/locales et schémas exotiques. `ws://`/`wss://` sont ramenés à
  `http(s)://` pour réutiliser le même contrôle. Le `route` handler de
  l'enrichissement (`DescriptionEnricher`) applique le même contrôle
  (`isSafeFetchDestination`) en plus de son filtre d'images. LIMITE : pas de
  résolution DNS dans le callback `route` (rebinding DNS non détecté sur les
  sous-ressources).
  **Vérifié** : `ctx.route()` et `recordHar` coexistent (le HAR n'est PAS vidé
  par l'interception — testé avec Chromium embarqué).
- **`isHostAllowed` inclusif** (domaine + sous-domaines) : rejette les suffixes
  trompeurs (`leboncoin.fr.attacker.com`) grâce au préfixe `.`.
- **IPv6 littérales** : `URL.hostname` conserve les crochets (`[::1]`) → les
  retirer avant `net.isIP`, sinon les IP privées IPv6 passent les contrôles.
- **Clés d'export vs clés du modèle** : `filterAdByFields` traduit les clés
  d'export (`ville`, `codePostal`, `vendeurNbAvis`, `vendeurAnciennete`) vers les
  clés du modèle `normalizeAd` (`city`, `zipcode`, `nombreAvis`,
  `vendeurAncienneteJours`) via `MODEL_KEY_FOR_EXPORT`. Ne PAS revenir à une
  copie `out[key] = ad[key]` : ces champs disparaîtraient des exports Défaut et
  Personnalisé.
- **Fiche détaillée : lire les DEUX clés vendeur** : `annonces.json` contient des
  clés d'export (`vendeurNote`, `vendeurNbAvis`, `vendeurNom`, `ville`,
  `codePostal`), pas les clés du modèle (`nombreAvis`, `city`, `zipcode`). La
  fiche détaillée (`openAdDetail`) doit lire les deux formes : elle lisait
  seulement `nombreAvis` → la note s'affichait SANS le nombre d'avis. Utiliser
  `cityOf`/`zipOf`/`locationLabel` (`utils.js`) pour la localisation. Le test
  `[46]` (jsdom) verrouille ce comportement.
- **Tests jsdom : `let` de portée eval** : un script injecté par `window.eval`
  place ses `let` (ex. `allJobsCache` dans `appState.js`) dans la portée de CET
  eval. Une affectation ultérieure via un AUTRE `window.eval('allJobsCache = …')`
  crée un global qui MASQUE la liaison lexicale → le module lit toujours
  l'ancienne valeur (fiche détaillée vide). Exposer des setters dans le même
  `eval` (cf. section `[46]`).
- **harCapturer warmup cancel** : si l'utilisateur annule pendant la résolution
  CAPTCHA (fenêtre visible), NE PAS persister `storageState` — la session est
  encore bloquée (cookies anti-bot). Fermer sans `storageState()`.
- **harCapturer CAPTCHA** : `domcontentloaded` + `sleep(1500)` était trop tôt pour
  détecter le CAPTCHA. Fix : `networkidle` + `sleep(3000)`. `_checkCaptcha` doit
  vérifier les iframes (Arkose/hCaptcha/reCaptcha/Cloudflare), les éléments DOM
  (`#challenge-form`, `.cf-turnstile`) et l'URL (`/captcha`, `/challenge`). Ne
  JAMAIS recharger la page pendant la résolution (polling sans reload).
- **UA différent entre warmup et capture** : chaque `_newStealthContext` ne doit
  PAS appeler `getRandomUserAgent()` à chaque fois. UA fixe choisi une fois dans
  le constructeur (`this._userAgent`), réutilisé par `_baseContextOptions`.
- **Renderer canvas null** : `renderCharts` doit vérifier l'existence des canvas
  avant `getContext('2d')`.
- **Renderer localStorage JSON** : `JSON.parse(cached)` sur un cache géocodage
  doit être dans un try/catch. En cas d'échec, `localStorage.removeItem` pour purger.
- **Écritures atomiques pour fichiers critiques** : `secretStore._save()`,
  `settings.saveSettings()` utilisent `atomicWriteFileSync` (tmp + rename).
- **Refresh après suppression job** : `askDeleteJob` doit rafraîchir l'explorateur/
  stats/sessionSelect → sinon données fantômes dans l'UI.
- **compareSet stale** : les IDs d'annonces supprimées doivent être nettoyés du
  compareSet au changement de cache.
- **`describeError` non importé (pipeline)** : `leboncoin-pipeline.js` utilisait
  `describeError` au recyclage de contexte (`createStealthContext` échoue) sans
  l'importer → `ReferenceError` masquait l'erreur réelle et perdait le log de
  diagnostic. Import depuis `utils/diagnostics` obligatoire.
- **`window.prompt()` (Electron)** : NON supporté par Electron → le bouton
  « Sauvegarder comme Preset » était totalement inopérant. Remplacé par la modale
  `#presetModal`. Ne pas réintroduire `prompt()` dans le renderer.
- **`loadPreset` et spread** : `applySearchConfig({ searchUrl: p.searchUrl, ...p })`
  laissait `p.url` écraser `searchUrl` (spread APRÈS les clés explicites) → URL du
  preset non chargée. Toujours mettre le spread AVANT les clés explicites.
- **`escapePath` ordre `&`/`"`** : échapper `&` APRÈS avoir généré `&quot;`
  double-encode (`&amp;quot;`). `&` doit être remplacé en PREMIER.
- **`--no-seller-data` en profil Maximum** : `filterAdByFields(ad, null, …)`
  renvoyait l'objet tel quel (early-return), donc l'exclusion vendeur était
  ignorée et les données vendeur fuyaient dans l'export Maximum. L'exclusion doit
  s'appliquer aussi quand `fields` est null.
- **Logs dev** : `logger._getLogDir()` écrivait dans `Documents` même en dev ;
  doit rester dans `./output/logs` (cohérent avec jobs/secrets), Documents
  uniquement en version packagée.
- **Fuite vendeur en profil Maximum (clés du modèle)** : `SELLER_FIELD_KEYS`
  (exportFields.js) doit contenir AUSSI les clés du modèle `normalizeAd`
  (`nombreAvis`, `vendeurAncienneteJours`), pas seulement les clés d'export
  (`vendeurNbAvis`, `vendeurAnciennete`). En profil Maximum, `filterAdByFields`
  opère sur les clés du modèle → sans elles, ces deux champs vendeur fuient
  malgré « Données vendeur » désactivé.
- **`mergeKeepingNonNull` et tableaux vides** : un tableau vide (`photosUrls: []`)
  doit être traité comme une ABSENCE de données, pas comme une valeur. Sinon une
  occurrence moins riche écrase une liste déjà extraite lors de la fusion de
  doublons (perte de photos).
- **`cleanOldHars(0)`** : doit être désactivé (retour 0), comme `cleanOldJobs`.
  Sans garde-fou, `maxAgeMs = 0` supprime TOUS les HAR (y compris ceux du jour).
- **`AdStats` repli deliveryType** : le repli rétro-compat doit reproduire
  `computeDeliveryType` : `false` + `null` → `aucun` (pas `inconnu`). Sinon
  l'onglet Stats diverge de l'explorateur/fiche annonce sur les mêmes données.
- **Widget — classes de statut** : `widget.html` ne doit PAS générer
  `'status-' + state` (classes CSS inexistantes → point sans couleur). Mapper
  explicitement chaque état sur `status-idle/running/error/completed`.
- **`main()` du pipeline** : `leboncoin-pipeline.js` DOIT garder son appel
  `main()` derrière `require.main === module`. Sans cela, un `require()` du
  pipeline (tests, bibliothèque) lance la CLI sans `.har` → sortie code 1.

## Code mort retiré
- `services/ai/` (adAnalyzer, marketValueAnalyzer, promptGenerator, promptTemplates,
  aiCache, ollamaHealth, providers/, search/) — IA entièrement supprimée.
- `aiStudioModule.js` (renderer) — module Navigateur IA Studio supprimé.
- `aistudioLoginPreload.js` (main) — preload anti-détection Google supprimé.
- `excelExporter.js` (infrastructure) — export XLSX/CSV supprimé.
- `runWithConcurrency` et `formatDuration` (utils/helpers.js) — non utilisés.
- `rapport.txt` (jobHistory.js) — chemin + champ vérifiant un fichier jamais créé.
- `DEFAULTS` (constants.js) — bloc mort conflictuel avec `SETTINGS_DEFAULTS`.
- `risk-keywords.js` (config/) — jamais importé dans l'app.
- `resumes-ia.json` — résumés IA compacts supprimés (plus d'IA).
- `export-meta.json` — métadonnées d'export XLSX/CSV supprimées.
- `infrastructure/notifications.js` — module mort, jamais importé (retiré avec
  l'import `Notifier` qu'il exposait).
- Import `FIELD_CATEGORIES` dans `exporting/dataProfiles.js` — inutilisé.

## Documents d'audit
- `docs/AUDIT_REPORT.md` — périmètre, constats, corrections, limites.
- `docs/STABILITY_PLAN.md` — lots, critères de validation, reste à faire.
- `docs/CHANGELOG.md` — journal des changements significatifs.
- `docs/KNOWN_ISSUES.md` — problèmes non résolus (build Windows, tests UI, etc.).
