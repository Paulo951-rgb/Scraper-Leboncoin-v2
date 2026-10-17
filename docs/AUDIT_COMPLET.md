# Audit intégral et stabilisation — Vendra

**Date :** 2026-10-17
**Périmètre :** dépôt `Paulo951-rgb/Scraper-Leboncoin-v2`, branche `main`, HEAD `9efc717`
**Nature :** audit technique et fonctionnel exhaustif + corrections ciblées vérifiées
**Méthode :** inventaire en lecture seule, sondes dynamiques sur le code réel, corrections
minimales, tests de régression ajoutés, validation par la suite complète.

> Ce document est le livrable d'audit. Il ne remplace pas `AUDIT_REPORT.md`
> (audit antérieur) ni `KNOWN_ISSUES.md` (problèmes ouverts, mis à jour ici).

---

## 1. État initial vérifié

| Élément | Constat |
|---|---|
| Branche | `main`, working tree propre, à jour avec `origin/main` |
| HEAD | `9efc717` — « Merge pull request #31 … feat/vendra-professional-rework » (clone *shallow*) |
| Dépendances | **absentes** au départ → `npm install` exécuté |
| Versions réellement installées | Electron **44.9.0**, Playwright **1.64.1**, electron-builder **26.15.3** |
| Suite de régression (avant) | **1548 réussis / 0 échoués** |
| Suite E2E Electron (avant) | **27 réussis / 0 échoués** |
| `npm audit --omit=dev` | **0 vulnérabilité** |
| `npm audit` (complet) | **9 vulnérabilités** (8 modérées, 1 élevée) — outillage de build uniquement |

Le dépôt a donc été audité **sur son état réel**, pas sur la foi des documents
(plusieurs écarts documentation ↔ code ont d'ailleurs été confirmés, §5).

---

## 2. Architecture réelle (confirmée par lecture du code)

```
Renderer (sandbox, contextIsolation, nodeIntegration=false)
  index.html + app.js + modules d'onglets (scraper/logs/history/explorer/stats/map/help)
        │  window.api.* (preload.js, contextBridge)
        ▼
Main process (main.js)
  core/ipcHandlers.js      handlers IPC (job, fichiers, secrets, config, sessions)
  core/settings.js         user-settings.json (migration + sanitize)
  config/constants.js      BASE_OUT_DIR, JOBS_DIR, GLOBAL_SESSION_PATH
  config/scraping.js       SCRAPING_POLICY figée (source unique, SANS electron)
        │  child_process.fork()
        ▼
Pipeline forké (services/scraping/leboncoin-pipeline.js)
  harCapturer.js (Playwright, warmup CAPTCHA, HAR)
  adFields.js (extracteurs PURS) → normalizeAd → deliveryType
  captureState.js (reprise page/HAR) · circuitBreaker.js · rateLimiter.js
  networkJournal.js · errorCodes.js
        │
        ▼
Exports (exporting/exportFields.js + dataProfiles.js)
  results/annonces.json (checksum SHA-256) + annonces.txt + report.json
        │
        ▼
Historique (jobs/jobHistory.js) → Explorateur / Statistiques / Carte
```

Points confirmés :
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` ; le renderer
  n'expose ni `require`, ni `process`, ni `fs`, ni `child_process` (vérifié par E2E).
- Les handlers IPC sont enregistrés une seule fois, via un getter `getWin()` qui
  filtre les fenêtres détruites (`!w.isDestroyed()`).
- Le pipeline forké n'importe **jamais** `electron` (contrainte respectée :
  `config/scraping.js` et `sessionPaths.js` sont importables hors Electron).
- Codes de sortie pipeline : `0` succès, `1` erreur fatale, `2` aucune donnée,
  `3` arrêt 403, `4` arrêt 429 ; `130` = interruption (SIGINT) côté runner.

### Inventaire quantitatif
- `src/main/` : ~30 modules JS (bootstrap, IPC, config, scraping, export, jobs,
  maintenance, infrastructure, utils).
- `src/renderer/` : `index.html`, `widget.html`, `widgetPreload`, ~12 modules JS
  + bibliothèques **vendored localement** (`vendor/` : Leaflet, Chart.js) — aucune
  dépendance CDN au chargement (fiabilité hors ligne).
- `test/` : `regression.test.js` (~4800 lignes, 49 sections), `e2e.electron.test.js`,
  fixtures HAR/HTML synthétiques.

---

## 3. Matrice fonctionnelle (extraits vérifiés)

| Zone | Action | Gestionnaire | Vérification |
|---|---|---|---|
| Scraper | Valider l'URL / lancer un job | `job:start` (ipcHandlers) | Sonde : validation config **avant** verrou (§4.3) |
| Scraper | Arrêt pendant capture / traitement | `job:cancel` + token `activeCancel` | Suite `[30]`, `[31]` |
| Scraper | Résultat partiel honnête | `state: 'partial'` | `[30]`, `[31]` |
| Logs | Filtrage, auto-scroll, buffer borné | `logsModule.js` | Suite `[37]` |
| Historique | Lister / ouvrir dossier / supprimer | `jobHistory.js`, `job:openSessionFolder` | `[38]` (anti path-traversal) |
| Explorateur | Table/grille, filtres, tri, pagination | `explorerModule.js` | `[47]` (DOM borné, page 500) |
| Statistiques | Cartes + 4 graphiques, sessions | `statsModule.js` | `[27]`, médiane paire |
| Carte | Leaflet, clusters, géocodage borné | `mapModule.js` | `[27]`, §4.2 |
| Paramètres | Charger/sauver/valider/persister | `config:get`/`config:save` | `[38]` (`sanitizeSettingsPatch`) |
| Aide | FAQ (25 entrées), liens externes filtrés | `helpModule.js`, `shell:openExternal` | E2E, `[38]` |

---

## 4. Anomalies confirmées et corrigées

### 4.1 — P1 · Prix tronqué sur les formats français
- **Fichier / fonction :** `src/main/services/scraping/adFields.js` → `extractPrice`
- **Problème observé :** `parseFloat('1 250 €') === 1`, `parseFloat('1.299,99') === 1.299`,
  `parseFloat('12,50') === 12`. Le prix était **silencieusement tronqué**.
- **Reproduction :** `node -e "require('./src/main/services/scraping/adFields').extractPrice({price:'1 250 €'})"`
  → `1` (avant) / `1250` (après). Également vérifié bout-en-bout via un HAR
  synthétique : `annonces.json` contenait `"prix": 1`.
- **Cause racine :** `parseFloat` s'arrête au premier caractère non numérique et ne
  gère ni les espaces de milliers ni la virgule décimale. La convention
  d'affichage (`AdStats`, renderer) faisait déjà la normalisation correcte : le
  parseur d'extraction était le seul divergent (source de vérité incohérente).
- **Impact utilisateur :** prix faux dans l'explorateur, les statistiques, les
  exports JSON/TXT et l'historique de prix (baisse/hausse erronées).
- **Correction :** ajout de `parsePriceString` (espaces retirés, `.` = milliers,
  `,` = décimal) utilisé pour tous les formats chaîne/array/objet. Les cas non
  numériques restent `null` (convention : jamais de valeur inventée).
- **Test :** section `[49]` (12 assertions) + `normalizeAd` de bout en bout.

### 4.2 — P2 · Marqueur de carte décalé (centroïde de regroupement)
- **Fichier / fonction :** `src/renderer/mapModule.js` → `clusterMarkers`
- **Problème observé :** le centroïde d'un groupe était divisé par le nombre
  d'**annonces** au lieu du nombre de **points**. Une ville unique portant
  5 annonces produisait `lat = 45.7 / 5 = 9.14` (marqueur hors de France).
- **Reproduction :** sonde VM sur `clusterMarkers([{lat:45.7,lng:4.8,ads:[×5]}],0.25)`
  → `lat 9.14` (avant) / `45.7` (après).
- **Cause racine :** accumulation `cell.lat += p.lat` par point, puis division par
  `cell.ads.length` (annonces). Les deux quantités ne sont pas interchangeables.
- **Impact utilisateur :** marqueurs/clusters placés au mauvais endroit dès qu'une
  ville concentre plusieurs annonces (cas courant).
- **Correction :** compteur `pointCount` dédié ; le centroïde est la moyenne des
  points regroupés.
- **Test :** section `[49]` (dont une assertion explicite que le calcul n'est PAS
  pondéré par le nombre d'annonces).

### 4.3 — P2 · Verrou de job permanent après une configuration invalide
- **Fichier / fonction :** `src/main/core/ipcHandlers.js` → handler `job:start`
- **Problème observé :** `isRunning = true` était positionné **avant** le bloc
  `try/finally`, et `sessionStats.pagesRequested = parseInt(config.pages, 10)`
  lisait `config.pages` **avant** toute validation. Un `config` absent/`undefined`
  (renderer compromis, message malformé) levait une exception **hors du `finally`** :
  `isRunning` restait `true` **pour toujours**.
- **Reproduction :** sonde simulant le handler avec `config === undefined` →
  `isRunning` reste armé ; tous les jobs suivants sont ignorés silencieusement
  jusqu'au redémarrage de l'application.
- **Cause racine :** validation absente avant l'armement du verrou + lecture
  d'une propriété non gardée hors `try`.
- **Impact utilisateur :** après un lancement invalide, **plus aucun job ne
  démarre**, sans message d'erreur explicite (blocage total de la fonction
  principale, récupérable seulement par redémarrage).
- **Correction :** validation de `config` (objet) et de `searchUrl` (chaîne non
  vide) **avant** `isRunning = true` ; `config.pages` remplacé par la variable
  déjà déstructurée. Aucun changement de comportement nominal.
- **Test :** section `[49]` (ordre validation → verrou vérifié statiquement +
  absence de `parseInt(config.pages, 10)`).

### 4.4 — P2 · Contamination croisée entre annonces lors de l'enrichissement
- **Fichier / fonction :** `src/main/services/scraping/leboncoin-pipeline.js` →
  `parseHtmlDescription(html, adId)`
- **Problème observé :** lorsque l'ID demandé était absent de la page de détail,
  le repli `exact || found[0]` renvoyait la description, le vendeur et l'état
  d'une **autre** annonce.
- **Reproduction :** fixture HTML contenant l'annonce `111` ; appel
  `parseHtmlDescription(html, '999999')` renvoyait la description de `111`
  (avant) / des champs `null` (après).
- **Cause racine :** repli inconditionnel sur le premier objet trouvé, sans
  vérifier qu'il correspond à l'annonce enrichie.
- **Impact utilisateur :** corruption silencieuse — une annonce héritait des
  données (vendeur, note, état, description) d'une autre (page supprimée,
  redirection, structure inattendue). Risque de données personnelles attribuées
  à la mauvaise annonce.
- **Correction :** rapprochement **strict** sur l'ID ; si l'ID est fourni mais
  introuvable → champs `null`. Le repli `found[0]` n'est conservé que pour un
  appel **sans** identifiant (aucun risque d'attribution erronée).
- **Test :** section `[49]` (ID absent → `null`, ID exact → enrichi, appel sans
  ID → repli documenté).

---

## 5. Écarts documentation ↔ réalité (corrigés)

| Document | Affirmation obsolète | Réalité vérifiée | Correction |
|---|---|---|---|
| `AGENTS.md`, `docs/ARCHITECTURE.md` | Electron 28, Playwright 1.41, electron-builder 24 | 44.9.0 / 1.64.1 / 26.15.3 | Versions mises à jour |
| `AGENTS.md` § « Vérification d'accès » | `_verifyAccess()` confirme l'accès sur statut HTTP réel | Fonction **absente** du code ; tests `[30]` asservissent son absence | Section réécrite (signaux réels de `_warmupSession`) |
| `AGENTS.md` pièges | « `_warmupSession` DOIT appeler `_verifyAccess()` » | Contredit le code et les tests | Entrée corrigée |
| `docs/ARCHITECTURE.md` | « Stats tab (charts, map) » | Onglets **séparés** Statistiques / Carte | Diagramme corrigé |
| `docs/KNOWN_ISSUES.md` KI-5 | « 8 vulnérabilités modérées » | **9** (8 modérées, 1 élevée : `extract-zip`) | KI-5 mis à jour |

Ces écarts ne sont pas que cosmétiques : un document qui décrit une protection
**absente** (ou une fonction supprimée) induit en erreur les mainteneurs.

---

## 6. Sécurité (audit défensif)

Vérifié par sondes et par lecture du code :

- **SSRF / URL de recherche :** `isSafeFetchDestination` refuse les IP privées,
  loopback, link-local, IPv6 (`[::1]`), les formes décimales/hexadécimales
  (`2130706433`, `0x7f000001`), les schémas exotiques, et applique une allowlist
  inclusive (`leboncoin.fr` et sous-domaines ; rejette `leboncoin.fr.attacker.com`).
  Câblé avant le lancement de Chromium **et** sur les sous-requêtes
  (`ctx.route('**/*')`).
- **Limite résiduelle (documentée) :** pas de résolution DNS dans le callback
  `route` → un DNS rebinding sur sous-ressource n'est pas détecté (KI-3).
- **XSS :** `escapeHtml` (contenu) / `escapePath` (attributs, ordre `&` avant `"`)
  ; aucun script inline dans `index.html` ; gestionnaires posés par délégation.
- **`sanitizeImageUrl` (renderer) :** rejette loopback/privées/métadonnées cloud
  et schémas non `http(s)` (test `[48]`).
- **IPC :** `shell:openExternal` filtré http(s) ; `file:openFolder/openFile`
  validés sous `BASE_OUT_DIR` ; `job:openSessionFolder` n'accepte qu'un ID
  `job-*` reconstruit côté main (anti path-traversal).
- **Secrets :** `safeStorage` (trousseau OS) avec repli AES-256-GCM **explicite**
  (avertissement console une fois). Clés `secret:*` filtrées par allowlist.
  **Résiduel :** le repli est signalé en console mais **pas dans l'UI** (KI-4) ;
  fonctionnalité non exposée par l'interface actuelle.
- **Intégrité :** checksum SHA-256 + écriture atomique (`.tmp` + `rename`).

---

## 7. Résultats des tests

| Commande | Résultat |
|---|---|
| `npm test` (régression) | **1571 réussis / 0 échoués** (1548 avant + 23 ajoutés en `[49]`) |
| `npm run test:e2e` (Electron réel) | **27 réussis / 0 échoués** |
| `node --check` (fichiers modifiés + tout `src/`) | OK |
| `npm audit --omit=dev` | 0 vulnérabilité (production) |
| `npm audit` | 9 avis, **outillage de build uniquement** |

> Le harnais E2E lance réellement Electron en headless (sans Xvfb nécessaire :
> `--ozone-platform=headless`), vérifie la navigation entre les 6 onglets,
> l'ouverture des modales, la FAQ (25 entrées) et l'absence de fuite Node.

### Nouvelle section `[49]` (23 assertions)
Prix (formats FR, array/objet, non numérique, `0 ≠ null`), carte (centroïde,
non-pondération), verrou `job:start` (ordre validation/verrou, URL, absence de
lecture précoce), enrichissement détail (ID absent → `null`, ID exact, sans ID).

---

## 8. Risques résiduels et limites de vérification

1. **KI-1 (P2) — Lancement Windows réel non testé.** Le build est produit
   nativement par la CI (`windows-latest`) et contrôlé par `tools/verify-dist.js`,
   mais l'exécution de l'installeur, le scraping réel et la désinstallation sous
   Windows 10/11 **n'ont pas pu être rejoués** (environnement Linux d'écriture).
2. **KI-2 (P3) — E2E métier partiel.** Les parcours complets (job réel avec
   capture réseau, annulation, export depuis l'UI) ne sont pas couverts de bout
   en bout ; la chaîne HAR→normalisation→export est couverte sur fixtures.
3. **KI-3 (P2) — DNS rebinding non détecté** sur les sous-ressources (limite
   structurelle du filtre synchrone dans `route`).
4. **KI-4 (P3) — Repli de chiffrement des secrets** à protection réduite,
   signalé en console mais pas dans l'UI (fonctionnalité non exposée).
5. **KI-5 (P3) — 9 avis de dépendances**, tous dans l'outillage de build, non
   corrigeables sans montée majeure ; aucun avis en production.
6. **KI-9 (P3) — Ambiguïté de format de prix** résiduelle pour un format
   anglo-saxon (non émis par la source française ; non observé).
7. **Non vérifié dans cet environnement :** build `electron-builder` complet
   (nécessite Wine + Xvfb pour le cross-build, ou Windows), et comportement
   face aux protections anti-bot réelles de Leboncoin (nécessite réseau + site).

**Aucune garantie absolue d'absence de bug n'est donnée.** Les corrections
ci-dessus sont celles **confirmées par reproduction** ; les points non
reproductibles sont documentés comme limites plutôt que « corrigés » à l'aveugle.

---

## 9. Fichiers modifiés

**Code :**
- `src/main/services/scraping/adFields.js` (4.1)
- `src/renderer/mapModule.js` (4.2)
- `src/main/core/ipcHandlers.js` (4.3)
- `src/main/services/scraping/leboncoin-pipeline.js` (4.4)

**Tests :**
- `test/regression.test.js` (nouvelle section `[49]`)

**Documentation :**
- `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/KNOWN_ISSUES.md`, `docs/AUDIT_COMPLET.md` (ce document)

---

## 10. Commandes de reproduction

```bash
npm ci
npm test                 # suite de régression (1571 attendus)
npm run test:e2e         # E2E Electron réel (27 attendus)
npm run coverage         # couverture (c8)
npm audit --omit=dev     # 0 vulnérabilité de production
node --check src/main/services/scraping/adFields.js   # (et autres fichiers)
```

---

# Passe d'audit complémentaire — 2026-10-17 (2e passe)

**Périmètre :** dépôt `Paulo951-rgb/Scraper-Leboncoin-v2`, branche `main`,
HEAD `c23ee79` (« Merge pull request #32 from Paulo951-rgb/audit-integral-stabilisation »).
**Nature :** chasse aux bugs complémentaire (boutons, IPC, scraper, exports,
concurrence, sécurité) + corrections vérifiées.
**Méthode :** sondes dynamiques sur le code réel (exécution des fonctions pures,
pas seulement lecture), correction minimale, test de régression par anomalie.

> Cette passe ne remplace pas la première (§1–§10 ci-dessus) : elle la complète.
> Les invariants documentés (`deliveryType`, profils d'export, codes de sortie,
> états `completed`/`partial`/`cancelled`/`error`/`refused`/`rate_limited`,
> politique de scraping fixe, rate limiting) **n'ont pas été modifiés**.

## 11. État initial vérifié (2e passe)

| Élément | Constat |
|---|---|
| Branche / HEAD | `main`, HEAD `c23ee79` (clone *shallow*, `grafted`) |
| Working tree initial | **propre** (aucune modification utilisateur non commitée) |
| Node | v24.21.0 |
| Suite de régression (avant) | **1571 réussis / 0 échoués** |
| Suite E2E Electron (avant) | **27 réussis / 0 échoués** |
| `npm audit --omit=dev` | **0 vulnérabilité** |
| `npm audit` (complet) | **9 vulnérabilités** (8 modérées, 1 élevée) — outillage de build uniquement |

## 12. Anomalies confirmées et corrigées (2e passe)

### 12.1 — P2 · SSRF renderer : `sanitizeImageUrl` laissait passer les IPv4-mappées IPv6
- **Fichier / fonction :** `src/renderer/utils.js` → `sanitizeImageUrl`
- **Problème observé :** les adresses IPv4 encapsulées en IPv6
  (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `::ffff:a9fe:a9fe` = métadonnées cloud
  `169.254.169.254`, `::ffff:a00:1`, `::ffff:c0a8:101`) n'étaient pas reconnues
  comme IP privées et passaient le filtre. Idem ULA non compressée
  (`0:0:0:0:0:0:0:1`, `fc00::`, `fd00::`) et NAT64 (`64:ff9b::`).
- **Reproduction :** sonde `sanitizeImageUrl('http://[::ffff:127.0.0.1]/x.jpg')`
  → URL acceptée (avant) / `null` (après).
- **Cause racine :** la détection IPv6 ne décompressait pas la notation
  IPv4-mappée/ULA et ne traitait pas les zéros compressés.
- **Impact :** une annonce malveillante (URL d'image) pouvait faire charger une
  ressource locale/interne depuis le renderer.
- **Correction :** helpers `_ipv6Groups`/`_isPrivateIPv4Octets` ; détection des
  plages privées IPv4/IPv6 y compris IPv4-mappée, ULA, NAT64 et loopback.
- **Test :** section `[50]` (26 cas, dont 13 URLs à rejeter).

### 12.2 — P1 · Perte de pages HAR lors de la reprise après CAPTCHA
- **Fichier / fonction :** `src/main/services/scraping/harCapturer.js` → `capture()`
- **Problème observé :** lors d'un blocage en cours de capture, la reprise après
  résolution CAPTCHA relançait un contexte Playwright avec le **même** chemin
  `recordHar` (`activeHarPath`). Playwright **tronque** le fichier HAR réutilisé :
  les pages déjà capturées avant le blocage étaient **perdues**.
- **Reproduction :** sonde Playwright réelle — réutilisation d'un `recordHar` sur
  le même chemin → « ÉCRASEMENT (page1 PERDUE) ».
- **Cause racine :** un nouveau contexte HAR ne peut pas s'ajouter à un fichier
  existant ; le chemin de reprise CAPTCHA n'était pas isolé (contrairement à la
  reprise incrémentale, qui utilise `capture-resume.har`).
- **Impact :** perte silencieuse de données (pages 1..N-1) exactement dans le cas
  où l'utilisateur a résolu un CAPTCHA — le scénario le plus coûteux.
- **Correction :** HAR dédié `capture-retry.har` pour la reprise CAPTCHA, puis
  **fusion** (`mergeHarFiles([outputHarPath, retryHarPath])`) dans le HAR principal.
- **Test :** section `[50]` (chemin dédié + `recordHar` sur `retryHarPath` +
  fusion ; absence de réutilisation de `activeHarPath`).

### 12.3 — P2 · Historique de prix : prix en chaîne FR tronqué
- **Fichier / fonction :** `src/main/services/jobs/jobHistory.js` → `buildAdHistory`
- **Problème observé :** `parseFloat('1 250 €') === 1` → `prix.initial`,
  `prix.actuel` et `prix.baisse` restaient `null` (aucun changement détecté) sur
  des jobs dont le prix est une chaîne FR.
- **Reproduction :** `buildAdHistory` avec deux jobs `« 1 250 € »` → `« 1 000 € »`
  → baisse `null` (avant) / `250` (après).
- **Cause racine :** `parseFloat` seul, là où le pipeline utilise
  `parsePriceString` (même classe de bug que §4.1, sur un autre chemin).
- **Impact :** détection de baisse/hausse de prix inopérante sur les données
  historiques (fonctionnalité « suivi de prix »).
- **Correction :** helper `_priceOf` basé sur `parsePriceString` (nombre conservé
  tel quel, chaîne normalisée, absence → `NaN`).
- **Test :** section `[50]` (chaîne FR + prix numérique inchangé).

### 12.4 — P2 · Annulation d'enrichissement rapportée « accès refusé (403) »
- **Fichier / fonction :** `src/main/services/scraping/circuitBreaker.js` →
  `stopInfo()` ; `leboncoin-pipeline.js` → handler SIGINT
- **Problème observé :** le handler SIGINT forçait `circuit.state = 'stopped'`.
  `stopInfo()` renvoyait alors un motif **`access_refused`** (status `null`) et le
  pipeline pouvait fixer un code de sortie 3 — une **annulation utilisateur**
  était donc présentée comme un refus 403 du serveur.
- **Reproduction :** sonde `CircuitBreaker` → `markCancelled()` puis
  `stopInfo()` → `null` (après) ; avant, un objet `access_refused` parasite.
- **Cause racine :** un seul état « stopped » couvrait deux causes distinctes
  (blocage d'accès vs arrêt volontaire), sans drapeau discriminant.
- **Impact :** rapport et message trompeurs (« accès refusé » pour un arrêt
  volontaire), risque de faux « succès partiel » avec motif 403 inexistant.
- **Correction :** ajout de `markCancelled()` + drapeau `cancelled` ; `stopInfo()`
  renvoie `null` sur annulation. Le pipeline appelle `markCancelled()` sur SIGINT.
  Les vrais blocages 403/429 continuent d'être rapportés (aucune régression).
- **Test :** section `[50]` (annulation → `stopInfo()` `null` ; 403/429 inchangés ;
  pipeline utilise `markCancelled()`, plus d'affectation directe `state='stopped'`).

### 12.5 — P2 · Réglages « Données vendeur » et « Rétention des logs » non appliqués avant redémarrage
- **Fichier / fonction :** `src/renderer/scraperModule.js` (`saveSettingsBtn`) ;
  `src/main/core/ipcHandlers.js` (`config:save`)
- **Problème observé :** décocher « Données vendeur » ou modifier la rétention des
  logs dans les Paramètres n'avait **aucun effet immédiat** : la colonne Vendeur /
  les filtres vendeur restaient affichés, et le logger conservait l'ancienne
  rétention jusqu'au redémarrage (le réglage n'était relu qu'au démarrage).
- **Reproduction :** lecture du code — `refreshSellerDataSetting()` n'était
  appelé qu'au chargement ; `logger.setRetention()` n'était appelé qu'au
  démarrage, jamais dans `config:save`.
- **Cause racine :** effets de bord d'un réglage appliqués uniquement à
  l'initialisation, pas au moment de l'enregistrement.
- **Impact :** interface incohérente avec les données réelles affichées (état
  visuel trompeur) ; rétention de logs modifiée sans effet jusqu'au redémarrage.
- **Correction :** `saveSettingsBtn` réapplique `window.refreshSellerDataSetting()`
  après sauvegarde ; `config:save` applique `logger.setRetention(...)` immédiatement.
- **Test :** section `[50]` (appels présents dans le code des deux handlers).

### 12.6 — P2 · Filtre/tri/affichage de prix de l'explorateur : chaînes FR tronquées
- **Fichier / fonction :** `src/renderer/explorerModule.js` (filtre, tri, tableau,
  grille, fiche) ; `src/renderer/utils.js` → nouveau `priceOf`
- **Problème observé :** `parseFloat('1 250 €')` → `1` : une annonce à `1 250 €`
  disparaissait sous un plafond de `1 300 €`, était mal triée, et le prix
  numérique était affiché sans espace de milliers. (Même classe de bug que §4.1
  et §12.3, sur les chemins d'affichage du renderer.)
- **Reproduction :** sonde reproduisant la ligne de filtre exacte
  (`{prix:'1 250 €'}` → `0` ; `{price:'1 250 €'}` → `1`).
- **Cause racine :** `parseFloat` sur la valeur brute, sans normalisation FR.
- **Impact :** filtres de prix faussés (annonces masquées), tri incorrect,
  affichage incohérent avec les statistiques.
- **Correction :** helper unique `priceOf(a)` (nombre conservé, chaîne FR
  normalisée, absence → `NaN`) utilisé par le filtre, le tri, le tableau, la
  grille, la fiche détaillée, la vue comparer et les popups de carte. Même
  convention que `adFields.parsePriceString` et `statsModule`.
- **Test :** section `[50]` (7 cas de `priceOf` + vérification d'usage dans
  l'explorateur).

### 12.7 — P3 · Import inutilisé dans `secretStore.js`
- **Fichier / fonction :** `src/main/utils/secretStore.js`
- **Problème :** `const { app, safeStorage } = require('electron')` — `app` n'est
  jamais utilisé (chemin résolu via `config/constants.js`).
- **Correction :** import réduit à `{ safeStorage }`. Aucun effet fonctionnel.

## 13. Éléments vérifiés sans anomalie (2e passe)

- **Parité des canaux IPC** : les 18 `ipcRenderer.invoke` du preload ont tous un
  `ipcMain.handle` ; les canaux widget (`widget:toggle/close/progress/status`)
  sont bien gérés dans `main.js` (pas d'orphelin). Aucun handler inutilisé.
- **Boutons FAQ / Aide / Feedback** : correctement câblés dans `helpModule.js`
  (`openFaqBtn`, `openHelpBtn`, `openFeedbackBtn`, `submitFeedbackBtn`) — le
  harnais E2E confirme l'ouverture de la FAQ (25 entrées).
- **Navigation par onglets** : `app.js` cible bien `[data-tab]` (correctif
  antérieur confirmé présent) ; l'E2E active les 6 onglets.
- **`isSafeFetchDestination`** (main) : IPv6 littérales, allowlist inclusive,
  IP privées/locales — corrects (pas de régression).
- **`secretStore` (KI-4)** : le repli AES-256-GCM est explicitement documenté et
  averti une fois en console ; la distinction avec le trousseau OS est préservée.
- **Politique de scraping fixe** : `config/scraping.js` (concurrence 25 bornée,
  délai nominal 400 ms) consommée par toutes les couches ; aucun contrôle
  modifiable dans l'UI (vérifié E2E).

## 14. Résultats des tests (2e passe)

| Commande | Résultat |
|---|---|
| `npm test` (avant correctifs) | 1571 réussis / 0 échoués |
| `npm test` (après correctifs) | **1600 réussis / 0 échoués** (section `[50]` : +29) |
| `npm run test:e2e` | **27 réussis / 0 échoués** |
| `npm audit --omit=dev` | **0 vulnérabilité** |
| `npm audit` | **9 vulnérabilités** (8 modérées, 1 élevée) — build uniquement |
| `node --check` (fichiers modifiés) | OK |

## 15. Fichiers modifiés (2e passe)

**Code :**
- `src/renderer/utils.js` (§12.1, §12.6 : `sanitizeImageUrl`, `priceOf`)
- `src/main/services/scraping/harCapturer.js` (§12.2)
- `src/main/services/jobs/jobHistory.js` (§12.3)
- `src/main/services/scraping/circuitBreaker.js` (§12.4)
- `src/main/services/scraping/leboncoin-pipeline.js` (§12.4)
- `src/renderer/scraperModule.js` (§12.5)
- `src/main/core/ipcHandlers.js` (§12.5)
- `src/renderer/explorerModule.js` (§12.6)
- `src/renderer/mapModule.js` (§12.6)
- `src/main/utils/secretStore.js` (§12.7)

**Tests :**
- `test/regression.test.js` (nouvelle section `[50]`)

**Documentation :**
- `docs/AUDIT_COMPLET.md` (ce document), `docs/KNOWN_ISSUES.md`, `docs/CHANGELOG.md`

## 16. Risques résiduels (2e passe)

- Les risques de la première passe (§8) restent valides (KI-1 Windows réel non
  testé, KI-2 E2E métier partiel, KI-3 DNS rebinding sur sous-ressources,
  KI-4 repli de chiffrement, KI-5 avis de build, KI-9 format anglo-saxon).
- **Non rejoué ici :** build `electron-builder` Windows complet (nécessite Wine +
  Xvfb ou un runner Windows) ; scraping réel contre Leboncoin (réseau + site).
- Les correctifs §12 sont couverts par des tests de régression déterministes
  (fonctions pures + assertions structurelles), pas par un parcours réseau réel.

**Aucune garantie absolue d'absence de bug n'est donnée.**
