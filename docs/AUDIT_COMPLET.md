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
