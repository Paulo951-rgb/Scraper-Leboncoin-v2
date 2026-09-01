# 🛒 Leboncoin Scraper Pro

Application de bureau **Electron** pour scraper, enrichir et analyser (via IA **100% locale**) des annonces [Leboncoin.fr](https://www.leboncoin.fr) : identification du produit, résumé, analyse visuelle, puis estimation de la **valeur marché réelle en €** (via recherche Internet + IA) avec verdict bénéfice/perte.

> Document écrit pour qu'une IA ou un développeur sans aucune connaissance préalable du projet puisse comprendre entièrement son fonctionnement, son architecture et son code.

---

## 📋 Table des matières

1. [Vue d'ensemble](#-vue-densemble)
2. [Fonctionnalités principales](#-fonctionnalités-principales)
3. [Module Navigateur IA Studio](#-module-navigateur-ia-studio)
4. [Architecture technique](#-architecture-technique)
5. [Structure du projet](#-structure-du-projet)
6. [Stack technique](#-stack-technique)
7. [Flux de fonctionnement](#-flux-de-fonctionnement)
8. [Modèle de données « Annonce »](#-modèle-de-données-annonce)
9. [Architecture IA (3 systèmes)](#-architecture-ia-3-systèmes)
10. [Interface utilisateur (onglets)](#-interface-utilisateur-onglets)
11. [Communication IPC](#-communication-ipc)
12. [Anti-blocage & session](#-anti-blocage--session)
13. [Sécurité](#-sécurité)
14. [Installation & lancement](#-installation--lancement)
15. [Configuration de l'IA](#-configuration-de-lia)
16. [Fichiers générés](#-fichiers-générés)
17. [Tests de non-régression](#-tests-de-non-régression)
18. [Limitations connues](#-limitations-connues)
19. [Avertissement légal](#-avertissement-légal)

---

## 🎯 Vue d'ensemble

**Leboncoin Scraper Pro** est une application desktop (Windows/Mac/Linux) construite avec **Electron** qui :

1. **Capture** les résultats d'une recherche Leboncoin (Chromium piloté par Playwright).
2. **Extrait** les annonces à partir du trafic réseau capturé (fichier `.har`).
3. **Enrichit** chaque annonce avec sa description complète (non présente dans les résultats bruts).
4. **Analyse chaque annonce** via une **IA locale** (Ollama, texte + vision) → identification du produit, résumé, attributs, état, défauts.
5. **Estime la valeur marché** via recherche Internet (DuckDuckGo sans clé / Tavily à clé) + IA locale → verdict en € (bénéfice/perte vs prix demandé).
6. **Exporte** les résultats en JSON, TXT et Excel (`.xlsx`) avec mise en forme conditionnelle.
7. Offre un **navigateur IA Studio intégré** (Google AI Studio via `<webview>`) + une bibliothèque de prompts préfaits à trous.

L'IA d'analyse d'annonce et de génération de prompts est **100% locale** (Ollama) : aucune clé API payante, aucun envoi de données vers le cloud. L'IA Marché effectue une recherche Internet (DuckDuckGo par défaut, sans clé) puis synthétise les résultats localement via Ollama.

L'application est pensée pour un usage **semi-automatisé** : l'utilisateur peut devoir résoudre un captcha manuellement si Leboncoin détecte une activité robotique — la détection de résolution est **automatique** (polling contenu + confirmation anti-faux-positif), le scraping reprend tout seul.

---

## ⚙️ Fonctionnalités principales

### Scraping & extraction
- 🚀 **Scraping automatisé** d'une URL de recherche Leboncoin sur plusieurs pages.
- 🔑 **Session globale persistante** (« Master Session ») pour éviter de repasser un captcha à chaque lancement.
- 🤖 **Détection automatique de blocage/captcha** avec pause, puis **détection automatique de résolution** (polling contenu 2s + confirmation anti-faux-positif) — la fenêtre se ferme et le scraping reprend sans attendre un timeout.
- 📝 **Extraction des descriptions complètes** en mode rapide parallèle (batchs via `Promise.all`, exécutées dans la page pour hériter des cookies/session).
- 📦 **Mode de remise** — remise en main propre vs livraison, avec libellé du transporteur (extraction défensive multi-chemins + enrichissement depuis la page de détail).
- 🏷️ **Catégorie exacte** de l'annonce (ex: Ordinateurs, Téléphones) extraite à la fois sur la liste et la page de détail.
- ⭐ **Note vendeur + nombre d'avis** (ex: 4,8/5 (27 avis)) extraits défensivement de l'objet `owner`.
- 🔄 **Rotation de User-Agent** (10 UA réalistes en rotation aléatoire, fixé pour toute la durée d'une capture).
- 🚀 **3 presets de vitesse** (Moyen / Rapide / Ultra-rapide) pour l'enrichissement des descriptions.
- ⏳ **Rate limiting adaptatif** — backoff exponentiel si Leboncoin répond lentement ou bloque (403/429).
- ⏹️ **Arrêt préventif** après 3 blocages 403/429 consécutifs pendant l'enrichissement (sauvegarde des données collectées).

### Analyse IA (architecture v2 — 3 systèmes)

#### IA 1 — Analyse d'annonce (`adAnalyzer.js`, pendant le scraping)
- 🧠 **Identification du produit** : l'IA croise titre + description + données scraper + photos pour reconstituer ce qu'est **réellement** l'objet vendu (modèle exact, marque, état, défauts, accessoires).
- 🖼️ **Analyse visuelle intégrée** (un seul appel texte + vision) : type de photo (réelle/constructeur/capture), état visible, défauts visibles, score d'authenticité — sur les 3 premières photos.
- 📝 **Résumé court** + liste d'informations clés (« batterie HS », « sans chargeur », « modèle 2021 »…).
- 🚫 **Pas de score, pas de scam score** : l'IA 1 comprend l'objet, elle ne le juge pas.
- 🧠 **Cache IA** — les annonces déjà analysées (même `list_id`) ne sont pas re-demandées (plafond 5000 entrées avec éviction des plus anciennes).
- 🩺 **Health-check Ollama** — vérifie que le serveur est démarré et le modèle chargé avant l'analyse.

#### IA 2 — Analyse de marché (`marketValueAnalyzer.js`, action manuelle)
- 🌐 **Recherche Internet** du modèle précis via un moteur de recherche (DuckDuckGo **sans clé** par défaut, Tavily **à clé** en option) — aucun résultat inventé.
- 💶 **Estimation de la valeur réelle en €** : l'IA locale synthétise les sources trouvées pour estimer la valeur réelle du produit, en tenant compte de l'état.
- 🏆 **Verdict en €** (pas de score 0-100) : `deltaEur = valeurRéelle − prixDemandé` → « Très bonne affaire » / « Bonne affaire » / « Prix correct » / « Trop cher ».
- 🔗 **Sources conservées** : les résultats de recherche réellement trouvés sont présentés à l'utilisateur (transparence).
- 🔧 **Réparation JSON tronqué** : si le contexte Ollama est trop petit, le JSON de sortie peut être coupé — réparation best-effort avec marquage `_repaired` (confiance baissée).

#### IA 3 — Génération de prompts (`promptGenerator.js`, module AI Studio)
- ✨ Génère un prompt d'analyse complet (~50 lignes) pour Google AI Studio, adapté à n'importe quel type de produit, via Ollama local.

### Export & visualisation
- 📊 **Export Excel (.xlsx)** stylisé (couleurs, filtres auto, liens, mise en forme conditionnelle selon le verdict).
- 📄 Export **JSON** (avec checksum SHA-256) et **TXT** lisible.
- 📄 Export **résumés IA compacts** (`resumes-ia.json` : numéro, titre, URL, prix, résumé — pour transmission à une IA externe).
- 🔍 **Explorateur d'annonces** — filtres (mot-clé, prix, verdict), tri, vue tableau/grille, fiche détaillée (photos, analyse IA, vision, verdict marché, sources), comparateur côte à côte.
- 📊 **Statistiques** — cartes colorées (Total, Prix Moyen/Min/Max, Livraison, Main Propre, Pro/Particulier) + 4 graphiques (Distribution des prix, Vendeurs, Top 10 Villes, Modes de Transaction) + carte Leaflet.
- 🗺️ **Carte interactive** (Leaflet) — répartition géographique avec filtre « remise main propre », géocodage via API Gouv France (cache + timeout 10s). Déduplication des annonces par id.
- 🆚 **Comparateur** d'annonces côte à côte.
- 📁 **Historique** complet des jobs avec suppression.
- 🖥️ **Widget flottant** always-on-top (progression temps réel).
- 🎨 **13 thèmes visuels**.
- 📶 **Mode hors-ligne** — badge de connectivité, scraping désactivé mais historique consultable.
- 📜 **Logs rotatifs** (un fichier par jour, rétention configurable) + console en direct avec mode normal/debug, auto-scroll, copie.
- ❓ **Système d'aide intégré** — FAQ (accordéon), guide d'utilisation pas à pas et formulaire de feedback (problèmes & améliorations), accessibles depuis l'en-tête.

---

## 🌐 Module Navigateur IA Studio

Onglet dédié intégrant **Google AI Studio directement dans le logiciel** (via `<webview>`) + bibliothèque de prompts préfaits.

### Composants
- **Navigateur webview intégré** ouvrant `https://aistudio.google.com/` avec boutons de navigation (précédent/suivant/recharger/accueil), barre d'URL, et ouverture dans le navigateur externe.
- **Connexion Google** via une fenêtre dédiée (BrowserWindow) — le `<webview>` étant bloqué par Google pour l'OAuth, une vraie fenêtre partage la même session persistante (`persist:aistudio`).
- **Anti-détection Google** : User-Agent Chrome réel (sans « Electron »), masquage des Client Hints `sec-ch-ua`, override de `navigator.userAgentData` et `navigator.webdriver` via preload dédié.
- **Prompts préfaits à trous** (`promptTemplates.js`) — 7 prompts longs, complets et génériques, affichés en cartes. Pour chacun : remplir les champs directement dans la carte, prévisualiser le prompt assemblé (« 👁 Voir le prompt »), copier le prompt rempli ou copier le prompt brut avec les trous. Aucune IA, aucune clé API.
- **Prompts IA internes** (`prompt:internal:list`) — les prompts réellement utilisés par l'IA Analyse (adAnalyzer) et l'IA Marché (marketValueAnalyzer) sont affichés et copiables (avec un exemple concret), pour comprendre ce que l'IA reçoit.
- **Bouton ouvrir dossier des jobs** — accès direct au dossier de sortie.
- **Drag & drop .json** — glisser un fichier d'annonces dans le chat AI Studio (le navigateur embarqué se comporte comme un Chrome normal).

> Note : un générateur de prompts par IA locale (`promptGenerator.js`) est câblé côté main process (handler `prompt:generate`) mais n'est pas exposé dans l'UI actuelle. Les prompts préfaits à trous le remplacent avantageusement (instantané, aucun appel IA).

### Fichiers
- `src/renderer/aiStudioModule.js` — logique renderer du module (cartes, navigateur, prompts internes).
- `src/main/services/ai/promptTemplates.js` — bibliothèque de prompts préfaits à trous.
- `src/main/services/ai/promptGenerator.js` — génération de prompts via Ollama local (handler câblé, non exposé en UI).
- `src/main/aistudioLoginPreload.js` — preload anti-détection pour la fenêtre de connexion Google.

---

## 🏗️ Architecture technique

Architecture standard **Electron** (main + renderer) avec un **sous-processus** dédié au traitement lourd :

```
┌─────────────────────────────────────────────────────────────────┐
│                  PROCESSUS MAIN (Node.js)                        │
│  main.js → BrowserWindow + ipcHandlers                          │
│  ┌────────────┐   ┌───────────────┐   ┌────────────────┐        │
│  │ HarCapturer │   │ PipelineRunner │   │  AdAnalyzer    │        │
│  │ (Playwright)│──▶│ (fork process) │──▶│  (IA 1 locale) │        │
│  └────────────┘   └───────────────┘   └───────┬────────┘        │
│       │                  │                    │                 │
│       ▼                  ▼                    ▼                 │
│   capture.har      annonces.json         adAnalysis             │
│                   (checksum SHA-256)     (produit, résumé,      │
│                                            vision, attributs)   │
│                                            → ExcelExporter      │
│                                                                 │
│  ┌──────────────────────────────┐  ┌──────────────────────┐     │
│  │ MarketValueAnalyzer (IA 2)   │  │ PromptGenerator(IA3) │     │
│  │  recherche Internet (DDG/    │  │  (module AI Studio)  │     │
│  │  Tavily) + synthèse IA locale│  └──────────────────────┘     │
│  └──────────────────────────────┘                               │
│       → marketAnalysis                                          │
│         (realValue, verdict en €, sources)                      │
└─────────────────────────────────────────────────────────────────┘
                            ▲ IPC (ipcMain ↔ ipcRenderer) ▼
┌─────────────────────────────────────────────────────────────────┐
│                PROCESSUS RENDERER (Chromium, sandboxé)           │
│  index.html + app.js + styles.css + aiStudioModule.js            │
│  + helpModule.js (FAQ/Guide/Feedback)                           │
│  Exposé via preload.js (contextBridge → window.api)             │
└─────────────────────────────────────────────────────────────────┘
```

Le main suit une **architecture en couches** : `core/` (orchestration), `services/` (métier), `infrastructure/` (intégrations), `config/` (configuration), `utils/` (utilitaires).

L'IA est abstraite via deux interfaces enfichables :
- **AIProvider** (`providers/`) : abstraction du moteur d'IA (Ollama local aujourd'hui, infrastructure distante demain). Les modules métier ne font jamais de `fetch` direct vers l'IA.
- **SearchProvider** (`search/`) : abstraction du moteur de recherche (DuckDuckGo sans-clé par défaut, Tavily à clé en option). L'IA Marché ne fait jamais de `fetch` direct vers un moteur de recherche.

### Pourquoi un sous-processus (`fork`) pour le pipeline ?

`leboncoin-pipeline.js` est un script CLI Node.js autonome lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler le traitement lourd (parsing de gros `.har`, jusqu'à plusieurs centaines de Mo) du main process pour ne pas geler l'UI ;
- de tuer/interrompre proprement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (logs formatés `[done/total]`).

---

## 📁 Structure du projet

```
leboncoin-scraper-app/
├── package.json                          # Métadonnées, dépendances, scripts
├── test/
│   └── regression.test.js                # Suite de non-régression (588 assertions)
└── src/
    ├── main/                             # Processus principal Electron
    │   ├── main.js                       # Cycle de vie + fenêtres + session AI Studio + webview lock
    │   ├── preload.js                    # Pont sécurisé Main ↔ Renderer (contextBridge)
    │   ├── widgetPreload.js              # Preload dédié au widget flottant
    │   ├── aistudioLoginPreload.js       # Preload anti-détection Google (fenêtre login)
    │   ├── core/
    │   │   ├── ipcHandlers.js            # Tous les handlers IPC + résumé de session
    │   │   └── settings.js               # Persistance user-settings.json
    │   ├── config/
    │   │   └── constants.js              # Chemins, thèmes (require electron/app)
    │   ├── services/
    │   │   ├── scraping/
    │   │   │   ├── harCapturer.js         # Capture HAR via Playwright + pré-check/détection captcha
    │   │   │   ├── pipelineRunner.js     # Lance le pipeline en fork + parse stdout
    │   │   │   ├── leboncoin-pipeline.js # CLI : HAR → annonces + enrichissement descriptions
    │   │   │   └── userAgents.js         # 10 User-Agents réalistes en rotation
    │   │   ├── ai/
    │   │   │   ├── adAnalyzer.js         # IA 1 — Analyse d'annonce (texte + vision) pendant scraping
    │   │   │   ├── marketValueAnalyzer.js# IA 2 — Marché : recherche Internet + verdict en €
    │   │   │   ├── promptGenerator.js    # IA 3 — Génération de prompts (handler câblé, non exposé UI)
    │   │   │   ├── promptTemplates.js    # Bibliothèque de prompts préfaits à trous
    │   │   │   ├── aiCache.js            # Cache IA (plafond 5000 + éviction, écriture debouncée)
    │   │   │   ├── ollamaHealth.js       # Health-check Ollama (serveur + modèle)
    │   │   │   ├── providers/            # Interface AIProvider + OllamaProvider + registry
    │   │   │   └── search/               # Interface SearchProvider + DuckDuckGo + Tavily + registry
    │   │   ├── analysis/
    │   │   │   └── adStats.js            # Statistiques de prix brutes (sans scoring)
    │   │   ├── jobs/
    │   │   │   └── jobHistory.js         # Listing/lecture/suppression jobs (checksum)
    │   │   └── maintenance/
    │   │       └── storageCleaner.js     # Nettoyage .har + jobs (âge = timestamp dossier)
    │   ├── infrastructure/
    │   │   ├── excelExporter.js          # Export .xlsx stylisé (exceljs)
    │   │   ├── fileManager.js            # Ouverture fichiers/dossiers (explorateur)
    │   │   └── notifications.js          # Notifications système (bonne affaire)
    │   └── utils/
    │       ├── helpers.js                # sleep, atomicWriteFileSync, cleanText...
    │       ├── diagnostics.js            # redact, formatBytes, summarizeAds, describeError
    │       ├── integrity.js              # Checksum SHA-256 + écriture atomique
    │       ├── rateLimiter.js            # Rate limiting adaptatif (backoff)
    │       ├── logger.js                 # Logger rotatif quotidien + rétention
    │       └── secretStore.js            # Secrets chiffrés (safeStorage + fallback AES)
    └── renderer/
        ├── index.html                    # UI (onglets, modales, webview AI Studio, FAQ/Help/Feedback)
        ├── widget.html                   # Widget flottant
        ├── app.js                        # Logique front-end (onglets, explorateur, stats, carte)
        ├── aiStudioModule.js             # Module Navigateur IA Studio + prompts préfaits/internes
        ├── helpModule.js                 # Module d'aide (FAQ + guide + feedback)
        └── styles.css                    # Habillage + 13 thèmes + stat-cards
```

---

## 🧰 Stack technique

| Composant          | Technologie          | Rôle                                                         |
|--------------------|----------------------|--------------------------------------------------------------|
| Shell applicatif   | **Electron 28**      | App web comme application desktop native                      |
| Scraping           | **Playwright 1.41**  | Pilotage Chromium, capture réseau HAR                        |
| IA locale          | **Ollama**           | IA 1 (analyse annonce) + IA 2 (synthèse marché) + IA 3 (prompts) |
| IA vision          | **Ollama LLaVA**     | Analyse d'images intégrée à l'IA 1 (texte + vision en un appel) |
| Recherche marché   | **DuckDuckGo / Tavily** | Moteur de recherche pour l'IA Marché (sans clé par défaut) |
| Export Excel       | **ExcelJS 4.4**      | Génération .xlsx stylisé                                     |
| Carte              | **Leaflet.js**       | Carte interactive des annonces                               |
| Graphiques         | **Chart.js**         | Distribution prix, vendeurs, top villes                       |
| Géocodage          | **API Gouv France**  | Coordonnées des villes (cache LocalStorage)                   |

---

## 🔄 Flux de fonctionnement

1. **Lancement** (`job:start`) → `HarCapturer` ouvre Chromium (headless), navigue vers Leboncoin.
2. **Pré-check captcha** : si blocage détecté (contenu ou HTTP ≥400), ouverture d'une fenêtre visible pour résolution manuelle. **Détection automatique de résolution** (polling contenu 2s + confirmation 2s anti-faux-positif). Session validée persistée dans `global-session.json`.
3. **Capture HAR** : navigation page par page, enregistrement du trafic filtré (`recherche|api|items`).
4. **Pipeline** (`fork`) : parse le HAR → extrait les annonces (`__NEXT_DATA__`) → normalise → déduplique → enrichit les descriptions (batchs parallèles + rate limiter, arrêt préventif après 3 blocages 403/429).
5. **IA Analyse** (si cochée, par défaut oui) : `AdAnalyzer.analyzeAds()` → pour chaque annonce, un seul appel Ollama (texte + vision si photos) → `adAnalysis { identifiedProduct, summary, attributes, keyInfo, vision, confidence }`. Cache pour les re-analyses. Écriture `annonces.json` + `resumes-ia.json`.
6. **Export** : `ExcelExporter.exportToXlsx()` → .xlsx stylisé + JSON/TXT déjà écrits par le pipeline.
7. **IA Marché** (action manuelle, bouton « 🌐 IA Marché » dans l'Explorateur) : `MarketValueAnalyzer.analyzeMarketBatch()` → pour chaque annonce, recherche Internet (DuckDuckGo/Tavily) + synthèse IA → `marketAnalysis { realValue, verdict, deltaEur, sources, rationale }`.
8. **Notification** : si « Très bonne affaire » détectée par l'IA Marché, notification système native.
9. **Historique** : job enregistré, accessible dans l'onglet Historique.

---

## 🗂️ Modèle de données « Annonce »

Chaque annonce normalisée (dans `annonces.json`) :

```jsonc
{
  "id": "2831923847",
  "title": "PC portable Gamer",
  "price": 450,
  "description": "Texte complet...",
  "url": "https://www.leboncoin.fr/ad/2831923847.htm",
  "images": ["https://...jpg"],
  "main_image": "https://...jpg",
  "city": "Lyon",
  "zipcode": "69000",
  "shipping": true,              // true = livraison, false = main propre, null = inconnu
  "handDelivery": false,         // true = remise en main propre uniquement
  "deliveryMode": "livraison",   // 'livraison' | 'main_propre' | 'inconnu'
  "deliveryLabel": "Chronopost", // libellé du transporteur si dispo (sinon null)
  "seller": "Jean D.",
  "isPro": false,
  "sellerRating": 4.8,           // note vendeur (0-5), null si indisponible
  "sellerRatingCount": 27,       // nombre d'avis, null si indisponible
  "date": "2026-08-01T10:00:00Z",
  "category": "Ordinateurs",     // catégorie exacte de l'annonce
  "raw": { /* objet __NEXT_DATA__ brut, pour debug */ },

  // adAnalysis — produit par l'IA 1 (AdAnalyzer) pendant le scraping.
  // Absent si l'analyse IA est décochée. _fallback:true si l'IA a échoué.
  "adAnalysis": {
    "identifiedProduct": "ASUS ROG Strix G15 (Ryzen 7, RTX 3060, 16Go)",
    "summary": "PC portable gamer ASUS ROG Strix G15, Ryzen 7 5800H, RTX 3060 6Go, 16Go RAM, SSD 512Go. Bon état général, coque légèrement rayée.",
    "category": "PC portable gamer",
    "attributes": {
      "brand": "ASUS",
      "model": "ROG Strix G15",
      "condition": "bon état",
      "defects": ["coque légèrement rayée"],
      "missing": [],
      "accessories": ["chargeur"],
      "working": "normal"
    },
    "keyInfo": ["Ryzen 7 5800H", "RTX 3060 6Go", "16Go RAM", "SSD 512Go"],
    "photoVsTextConsistency": "cohérent",
    "confidence": "haute",
    // vision : présent seulement si des photos étaient disponibles ET un modèle vision configuré
    "vision": {
      "photoType": "REAL_PRODUCT",        // REAL_PRODUCT | STOCK_PHOTO | SCREENSHOT | UNCLEAR
      "visibleCondition": "GOOD",          // NEW | LIKE_NEW | GOOD | WORN | DAMAGED
      "visibleDefects": ["rayures coque"],
      "authenticityScore": 85,             // 0-100
      "summary": "Photos réelles du produit, état cohérent avec la description."
    }
  },

  // marketAnalysis — produit par l'IA 2 (MarketValueAnalyzer), action manuelle.
  // Absent tant que l'IA Marché n'a pas été lancée. _fallback:true si échec.
  "marketAnalysis": {
    "realValue": 600,             // valeur marché estimée en € (null si non déterminable)
    "valueRangeLow": 510,         // borne basse de la fourchette
    "valueRangeHigh": 690,        // borne haute
    "condition": "bon état",
    "sourcesUsed": 6,             // nb de sources réellement trouvées
    "sources": [                  // résultats de recherche réels (transparence)
      { "title": "...", "snippet": "...", "url": "...", "source": "..." }
    ],
    "sourcesInsufficient": false,
    "aberrantPricesFiltered": [],
    "comparisonsAvoided": [],
    "rationale": "Prix marché basé sur 6 annonces similaires…",
    "confidence": "haute",       // haute | moyenne | basse
    "verdict": "Bonne affaire — bénéfice potentiel : +150 €",
    "verdictLabel": "Bonne affaire",   // Très bonne affaire | Bonne affaire | Prix correct | Trop cher | Très cher | Non déterminable
    "deltaEur": 150,             // valeurRéelle − prixDemandé (null si non déterminable)
    "deltaPct": 33               // deltaEur / prixDemandé × 100 (null si non déterminable)
  }
}
```

> **Anciens champs supprimés** (architecture v1, plus présents) : `dealTag`, `dealDiscountPct`, `hasRisk`, `detectedRisks`, `classification`, `scamScore`, `score`, `diffEur`, `diffPct`, `netMarginEur`, `roiPct`, `marketAnalysis.productName`, `marketAnalysis.marketAvg/Min/Max`, `imageAnalysis` (intégré dans `adAnalysis.vision`).

---

## 🧠 Architecture IA (3 systèmes)

L'architecture v2 sépare clairement 3 systèmes IA indépendants, chacun avec une mission unique. **Aucun scoring heuristique** : l'ancien système de points/multiplicateurs/scam score a été entièrement supprimé.

### IA 1 — AdAnalyzer (`adAnalyzer.js`)
- **Quand** : pendant le scraping (si « Analyse IA » cochée, par défaut oui).
- **Mission** : reconstituer ce qu'est **réellement** l'objet vendu (titre souvent vague → modèle exact via description + photos).
- **Un seul appel Ollama** recevant texte + images simultanément (si modèle vision configuré + photos présentes). Dégradation texte-seul sinon.
- **Sortie** : `adAnalysis { identifiedProduct, summary, attributes{brand,model,condition,defects,missing,accessories,working}, keyInfo, photoVsTextConsistency, confidence, vision{photoType,visibleCondition,visibleDefects,authenticityScore,summary} }`.
- **Pas de score, pas de jugement** : l'IA 1 comprend, elle n'évalue pas.
- **Cache** par `list_id` (préfixe `analyse:`), plafond 5000 entrées.

### IA 2 — MarketValueAnalyzer (`marketValueAnalyzer.js`)
- **Quand** : action manuelle (bouton « 🌐 IA Marché » dans l'Explorateur), après le scraping.
- **Mission** : estimer la **valeur marché réelle en €** du produit, via :
  1. Construction d'une requête de recherche précise à partir de l'`adAnalysis` (identifiedProduct + model + brand + condition).
  2. Recherche Internet via SearchProvider (DuckDuckGo sans-clé par défaut, Tavily à clé en option) — **aucun résultat inventé**.
  3. Synthèse IA locale des sources trouvées → estimation de la valeur réelle en tenant compte de l'état.
  4. Calcul du verdict : `deltaEur = realValue − prixDemandé`.
- **Verdict** (`computeVerdict`) : basé sur `deltaPct` (delta / prix × 100) :
  - `deltaPct ≥ +40%` → « Très bonne affaire »
  - `+15% à +40%` → « Bonne affaire »
  - `−15% à +15%` → « Prix correct »
  - `−40% à −15%` → « Trop cher »
  - `≤ −40%` → « Très cher »
- **Sortie** : `marketAnalysis { realValue, valueRangeLow, valueRangeHigh, verdict, verdictLabel, deltaEur, deltaPct, sources[], rationale, confidence }`.
- **Réparation JSON tronqué** : si le contexte Ollama (8192 tokens) est trop petit, le JSON peut être coupé — réparation best-effort (`_repairTruncatedJson`) avec marquage `_repaired` (confiance baissée).
- **Cache** par `list_id` (préfixe `market:`).

### IA 3 — PromptGenerator (`promptGenerator.js`)
- **Quand** : module AI Studio (handler `prompt:generate` câblé, non exposé en UI actuellement).
- **Mission** : générer un prompt d'analyse complet (~50 lignes) pour Google AI Studio, adapté à n'importe quel type de produit.
- Remplacé en pratique par les **prompts préfaits à trous** (`promptTemplates.js`), instantanés et sans appel IA.

### Interfaces enfichables

| Interface | Implémentation(s) | Rôle |
|---|---|---|
| `AIProvider` (`providers/`) | `OllamaProvider` | Abstraction du moteur d'IA (chatText + chatVision) |
| `SearchProvider` (`search/`) | `DuckDuckGoSearchProvider` (sans clé), `TavilySearchProvider` (à clé) | Abstraction du moteur de recherche |

> Les modules métier (adAnalyzer, marketValueAnalyzer, promptGenerator) ne font **jamais** de `fetch` direct : ils passent toujours par `getAIProvider()` / `getSearchProvider()`.

---

## 🖥️ Interface utilisateur (onglets)

| Onglet | Description |
|---|---|
| 🚀 **Scraper** | Lancement d'un scraping (URL, pages, limite, proxy, config IA Ollama, options), presets 1-clic, progression temps réel. **Analyse IA cochée par défaut** (identification produit + résumé + vision si photos, pendant le scraping). |
| 🤖 **Navigateur IA Studio** | Navigateur intégré (Google AI Studio) + prompts préfaits à trous + prompts IA internes visibles/copiables + bouton dossier jobs + drag & drop .json. |
| 📜 **Logs** | Console de logs en direct (info/warn/error/debug) avec mode normal/debug, auto-scroll, copie, vidage, compteur. |
| 📁 **Historique Jobs** | Liste des scrapings passés + accès fichiers (XLSX/JSON/TXT/Résumés IA) + suppression. |
| 🔍 **Explorateur Annonces** | Filtres (mot-clé, prix, verdict), tri, vue tableau/grille, fiche détaillée (photos, analyse IA, vision, verdict marché, sources), comparateur, analyse marché manuelle (bouton « 🌐 IA Marché »). |
| 📊 **Statistiques & Carte** | cartes colorées (Total, Prix Moyen/Min/Max, Livraison, Main Propre, Pro/Particulier) + 4 graphiques (Distribution prix, Vendeurs, Top 10 Villes, Modes de Transaction) + carte Leaflet (filtre main propre, déduplication par id). |

### ⚙️ Modale Paramètres

- **Thème** : 13 thèmes (aperçu temps réel).
- **Vitesse de scraping** : Moyen (10 parallèles, 0,5-1s) / Rapide (15 parallèles, 0,2-0,6s) / Ultra-rapide (25 parallèles, 0,05-0,3s). Queue dynamique avec workers persistants.
- **Délai entre les pages** (ms, défaut 1000).
- **Mode de capture** : invisible (headless) ou visible (sauf CAPTCHA qui bascule toujours en visible).
- **Analyses IA simultanées** (parallélisme Ollama, défaut 5).
- **Nettoyage auto des .har** (jours, défaut 7).
- **Suppression auto des jobs** (optionnel, basée sur le timestamp du dossier — non le mtime qui est rafraîchi).
- **Rétention des logs** (jours, défaut 7).

Paramètres persistés dans `user-settings.json` (dossier `userData`). Bouton **Réinitialiser** pour les valeurs par défaut.

---

## 🔌 Communication IPC

Le renderer n'a **aucun accès direct à Node.js** (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). Toute communication passe par `preload.js` → `window.api` → `ipcMain` dans `ipcHandlers.js`.

**Canaux IPC** (29 canaux main + 3 canaux main→renderer) :

| Catégorie | Canaux |
|---|---|
| Job scraping | `job:start` (on), `job:stop` (on), `job:getHistory` (handle), `job:delete` (handle) |
| IA Marché | `market:analyze` (handle) |
| Prompts | `prompt:generate` (handle), `prompt:templates:list` (handle), `prompt:templates:build` (handle), `prompt:internal:list` (handle) |
| Ollama | `ollama:health` (handle), `ollama:models` (handle) |
| Recherche | `search:providers` (handle) |
| Fichiers | `file:openFolder` (handle), `file:openFile` (handle), `jobs:openFolder` (handle), `shell:openExternal` (handle) |
| Config | `config:get` (handle), `config:save` (handle), `app:getDiagnostics` (handle) |
| Secrets | `secret:get` (handle), `secret:set` (handle), `secret:has` (handle), `secret:remove` (handle) |
| Réseau | `network:check` (handle) |
| Widget | `widget:toggle` (on), `widget:progress` (on), `widget:status` (on), `widget:close` (on) |
| AI Studio | `aistudio:openLogin` (on) |
| Main→Renderer | `log`, `progress`, `status` (emit vers le renderer) |

Les listeners utilisent `removeAllListeners` avant re-souscription pour éviter les fuites. Le getter `getMainWindow()` renvoie null si la fenêtre est détruite (pas de capture par closure). Les handlers IPC sont enregistrés **une seule fois** dans `app.whenReady`.

---

## 🛡️ Anti-blocage & session

- **Session globale persistante** (`global-session.json`) : cookies validés réutilisés pour tous les jobs suivants.
- **Sauvegarde intelligente** : session globale sauvegardée dès la 1ère page réussie (HTTP <400), **jamais écrasée ensuite** (les 403 suivants ne corrompent pas la session).
- **Détection double** : marqueurs textuels (`captcha`, `robot`, `restreint`...) + iframes Arkose/FunCaptcha/Cloudflare (cross-origin) + URL de redirection **ou** HTTP ≥400 (détecte les 403 silencieux).
- **Bascule fenêtre visible** si blocage au pré-check.
- **Détection automatique de résolution** : polling du contenu de la page toutes les 2s (plus de vStatus figé) + confirmation anti-faux-positif (re-vérification après 2s). La fenêtre se ferme et le scraping reprend dès que le CAPTCHA est résolu.
- **UA fixe pour toute la capture** : un User-Agent unique choisi à l'initialisation garantit la cohérence de l'empreinte (UA différent entre warmup et capture → détection).
- **Arrêt préventif enrichissement** après 3 blocages 403/429 consécutifs (sauvegarde des données collectées).
- **Support proxy** HTTP optionnel.
- **Masquage `navigator.webdriver`**, UA Chrome réaliste, locale `fr-FR`.

---

## 🔒 Sécurité

- **Sandbox renderer** : `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (fenêtre principale + widget).
- **Webviews verrouillés** (`will-attach-webview`) : tout `<webview>` créé dynamiquement se voit forcer `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true` + suppression de tout preload injecté par le renderer + isolation de session.
- **Fenêtre login Google** : `contextIsolation` volontairement **désactivé** (pour override `navigator.userAgentData`/`webdriver` avant les scripts Google) MAIS ne charge QUE des URL `https://*.google.com` (validation stricte, repli sur page défaut sinon) + `nodeIntegration:false`.
- **Path-traversal bloqué** : `isPathAllowed()` n'autorise que les chemins dans `BASE_OUT_DIR` ; `deleteJob()` valide le format `job-<timestamp>` + double-check du chemin résolu.
- **`shell:openExternal` filtré** : seuls `http:`/`https:` sont autorisés (bloque `file:`, `javascript:`, `data:`).
- **Secrets chiffrés** : `safeStorage` OS (Keychain/DPAPI/libsecret) + fallback AES-256-GCM si indisponible. Clés API (Tavily) jamais en clair, stockées dans `secrets.enc.json`.
- **Intégrité des données** : checksum SHA-256 (`writeWithChecksum`/`readWithChecksum`), écriture atomique (`.tmp` + `rename`) sur tous les fichiers JSON critiques.
- **Single-instance lock** : empêche plusieurs instances concurrentes (conflit session/fichiers).

---

## 🚀 Installation & lancement

### Prérequis
- [Node.js](https://nodejs.org/) (version récente)
- [Ollama](https://ollama.com) installé et démarré (`ollama serve`) avec un modèle (`ollama pull llama3`)

### Installation

```bash
npm install
npx playwright install chromium
```

### Lancement

```bash
npm start
```

(`electron --max-old-space-size=8192 .` — 8 Go alloués à V8 pour les gros `.har`)

### Emplacement des fichiers
- **Dev** : `./output/`
- **Packagé (.exe)** : `Documents/Leboncoin Scraper Pro/`

---

## 🤖 Configuration de l'IA

| Usage | Moteur | Configuration |
|---|---|---|
| IA 1 — Analyse d'annonce (texte + vision) | **Ollama (local, gratuit)** | Onglet Scraper → modèle texte (ex: `llama3`) + modèle vision (ex: `llava`). La vision est automatique si des photos sont présentes et le modèle configuré. Health-check intégré. |
| IA 2 — Analyse de marché (valeur en €) | **Ollama (local)** + recherche Internet | Bouton « 🌐 IA Marché » dans l'Explorateur. Moteur de recherche : DuckDuckGo (sans clé, défaut) ou Tavily (clé API, plus fiable). |
| IA 3 — Génération de prompts | **Ollama (local)** | Handler câblé, non exposé en UI (remplacé par les prompts préfaits à trous). |

**OpenAI a été retiré** : l'IA se fait 100% en local via Ollama (aucune clé payante pour l'analyse). La seule clé optionnelle est celle de Tavily (moteur de recherche pour l'IA Marché), stockée chiffrée via `safeStorage`.

**Modèles recommandés** :
- Texte : `llama3` ou `mistral` (`ollama pull llama3`)
- Vision : `llava` ou `moondream` (`ollama pull llava`)

---

## 📦 Fichiers générés

Pour chaque job (`output/jobs/job-<timestamp>/`) :

| Fichier | Contenu | Généré par |
|---|---|---|
| `capture.har` | Trace réseau brute (filtrée `recherche\|api\|items`) | HarCapturer |
| `session-state.json` | Cookies/session du job (si sauvegardés) | HarCapturer / pipeline |
| `results/annonces.json` | Données structurées + `adAnalysis` + `marketAnalysis` (checksum SHA-256) | Pipeline + AdAnalyzer + MarketValueAnalyzer |
| `results/annonces.txt` | Export texte lisible (blocs) | Pipeline |
| `results/annonces.xlsx` | Export Excel stylisé (verdict, valeur marché, sources) | ExcelExporter |
| `results/resumes-ia.json` | Résumés IA compacts (numéro, titre, URL, prix, résumé) pour transmission externe | ipcHandlers (writeSummaryFile) |

> **Pas de CSV** : le pipeline ne génère que JSON + TXT (+ XLSX par l'ExcelExporter). L'Excel (.xlsx) remplace le CSV avec une mise en forme conditionnelle selon le verdict.

Fichiers runtime (dossier `userData` ou `output/` en dev) :
- `global-session.json` — session Leboncoin persistante (Master Session)
- `ai-cache.json` — cache IA (préfixes `analyse:` / `market:`, plafond 5000)
- `user-settings.json` — paramètres utilisateur
- `secrets.enc.json` — secrets chiffrés (clé Tavily)
- `logs/scraper-YYYY-MM-DD.log` — logs rotatifs quotidiens

---

## 🧪 Tests de non-régression

`test/regression.test.js` — script Node.js autonome (sans framework externe), **588 assertions** couvrant :

1. **utils** — diagnostics, helpers, integrity (checksum), rateLimiter, logger, secretStore.
2. **Modules principaux** — AdAnalyzer, MarketValueAnalyzer, AdStats, StorageCleaner, settings, aiCache.
3. **Pipeline via fork** — crée un faux HAR, lance le vrai pipeline, vérifie l'extraction.
4. **Corrections & renderer** — fixes présents (mapInstance, escapeHtml, stats, gestion 429, escapePath double-contexte).
5. **Architecture** — structure en couches, contrat IPC (29 canaux), widget, sandbox, verrouillage webview.
6. **Features** — intégrité SHA-256, rate limiting, logs rotatifs, health-check Ollama, secretStore, suppression auto jobs, mode hors-ligne, module AI Studio, module d'aide (FAQ/Help/Feedback), prompts préfaits, prompts IA internes.
7. **Audit fiabilité** — crash renderer (getAiApiKey), nettoyage jobs (timestamp), timeout géocodage, plafond cache IA, concurrence market:analyze (verrou), exit code pipeline (CLI error → exit 1), pagesScraped tracker, fix img.data.length.
8. **CAPTCHA** — détection automatique de résolution (latestHttpStatus dynamique, polling content-based, confirmation anti-faux-positif).

### Exécuter

```bash
node test/regression.test.js
```

Résultat attendu : `=== RÉSULTAT : 588 réussis, 0 échoués ===`

> Le test installe des **stubs** pour `electron`, `playwright` et `exceljs` afin de `require()` les modules en Node pur, sans lancer Electron/Chromium.

---

## ⚠️ Limitations connues

- Le scraping repose sur la structure actuelle de Leboncoin (`__NEXT_DATA__`, endpoints de recherche) : toute évolution du site peut nécessiter une adaptation du parsing.
- La résolution de captcha est **manuelle** (l'app ouvre une fenêtre visible), mais la **détection de résolution est automatique** (polling contenu 2s + confirmation) — l'utilisateur n'a pas à fermer la fenêtre ni à cliquer quoi que ce soit.
- L'analyse IA dépend de la qualité du modèle Ollama (`llama3` local peut être moins précis qu'un modèle cloud).
- L'IA Marché dépend de la disponibilité du moteur de recherche : DuckDuckGo (sans clé) peut être bloqué par son anti-bot en concurrence → utiliser Tavily (à clé) pour plus de fiabilité.
- L'enrichissement des descriptions est parallèle (10 simultanées en mode Rapide) : en cas de 403, arrêt auto après 3 blocages et sauvegarde des données collectées.
- Un blocage IP déjà actif peut nécessiter d'attendre ou d'utiliser un proxy.
- La connexion Google dans AI Studio peut être bloquée par Google malgré l'anti-détection (UA spoofing, Client Hints, `navigator.userAgentData`).

---

## ⚖️ Avertissement légal

Cet outil interagit avec un site tiers (Leboncoin.fr) dont les [conditions d'utilisation](https://www.leboncoin.fr/) peuvent restreindre ou interdire le scraping automatisé. L'utilisation de cette application est sous l'entière responsabilité de l'utilisateur, qui doit s'assurer de respecter la législation applicable (RGPD pour les données de vendeurs particuliers, CGU du site) avant tout usage, notamment commercial.
