# 🛒 Leboncoin Scraper Pro

Application de bureau **Electron** pour scraper, enrichir, analyser (via IA **100% locale**) et exporter des annonces [Leboncoin.fr](https://www.leboncoin.fr), avec détection de bonnes affaires, estimation de valeur marché, calcul de marge de revente et détection d'arnaques.

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
9. [Algorithme de scoring](#-algorithme-de-scoring)
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
4. **Analyse le marché** via une **IA locale** (Ollama) pour estimer si le prix est une bonne affaire, une arnaque potentielle, ou un prix correct.
5. **Exporte** les résultats en JSON, CSV, TXT et Excel (`.xlsx`) avec mise en forme conditionnelle.
6. Offre un **navigateur IA Studio intégré** pour générer des prompts d'analyse personnalisés via Ollama et les utiliser dans Google AI Studio directement dans le logiciel.

L'IA est **100% locale** (Ollama) pour l'analyse par annonce et la génération de prompts : aucune clé API payante, aucun envoi de données vers le cloud, fonctionnement hors-ligne.

L'application est pensée pour un usage **semi-automatisé** : l'utilisateur peut devoir résoudre un captcha manuellement si Leboncoin détecte une activité robotique, après quoi le scraping reprend automatiquement.

---

## ⚙️ Fonctionnalités principales

### Scraping & extraction
- 🚀 **Scraping automatisé** d'une URL de recherche Leboncoin sur plusieurs pages.
- 🔑 **Session globale persistante** (« Master Session ») pour éviter de repasser un captcha à chaque lancement.
- 🤖 **Détection automatique de blocage/captcha** avec pause et reprise après résolution manuelle.
- 📝 **Extraction des descriptions complètes** en mode rapide parallèle (batchs de 10 via `Promise.all`, exécutées dans la page pour hériter des cookies/session).
- 📦 **Mode de remise** — remise en main propre vs livraison, avec libellé du transporteur (extraction défensive multi-chemins + enrichissement depuis la page de détail).
- 🏷️ **Catégorie exacte** de l'annonce (ex: Ordinateurs, Téléphones) extraite à la fois sur la liste et la page de détail.
- ⭐ **Note vendeur + nombre d'avis** (ex: 4,8/5 (27 avis)) extraits défensivement de l'objet `owner`.
- 🔄 **Rotation de User-Agent** (10 UA réalistes en rotation aléatoire).
- 🚀 **3 presets de vitesse** (Rapide / Équilibré / Prudent).
- ⏳ **Rate limiting adaptatif** — backoff exponentiel si Leboncoin répond lentement ou bloque (403/429).

### Analyse IA (100% locale via Ollama)
- 🧠 **Analyse IA par annonce** (`marketAnalyzer.js`) : identification du produit, gamme, état, type de photo, puis calcul d'un **score 0-100**, d'une **classification**, d'une **marge de revente (ROI)** et d'un **scam score**.
- 🖼️ **Analyse d'images par IA Vision** (optionnelle) — les 3 premières photos analysées (type, état, défauts, authenticité).
- 🧠 **Cache IA** — les annonces déjà analysées (même `list_id`) ne sont pas re-demandées (plafond 5000 entrées avec éviction des plus anciennes).
- 🩺 **Health-check Ollama** — vérifie que le serveur est démarré et le modèle chargé avant l'analyse.

### Export & visualisation
- 📊 **Export Excel (.xlsx)** stylisé (couleurs, filtres auto, liens, mise en forme conditionnelle).
- 📄 Export **JSON, CSV et TXT** lisible.
- 🔍 **Explorateur d'annonces** — filtres (mot-clé, prix, tag de deal), tri, vue tableau/grille, fiche détaillée, comparateur.
- 📊 **Statistiques** — 8 cartes colorées (Total, Prix Moyen/Médian/Min/Max, Main Propre, Pro/Particulier) + 3 graphiques (Distribution des prix, Vendeurs, Top 10 Villes).
- 🗺️ **Carte interactive** (Leaflet) — répartition géographique avec filtre « remise main propre », géocodage via API Gouv France (cache + timeout 10s). Déduplication des annonces par id.
- 🆚 **Comparateur** d'annonces côte à côte.
- 📁 **Historique** complet des jobs avec suppression.
- 🖥️ **Widget flottant** always-on-top (progression temps réel).
- 🎨 **13 thèmes visuels**.
- 📶 **Mode hors-ligne** — badge de connectivité, scraping désactivé mais historique consultable.
- 📜 **Logs rotatifs** (un fichier par jour, rétention configurable).
- ❓ **Système d'aide intégré** — FAQ (accordéon), guide d'utilisation pas à pas et formulaire de feedback (problèmes & améliorations), accessibles discrètement depuis l'en-tête.

---

## 🌐 Module Navigateur IA Studio

Onglet dédié intégrant **Google AI Studio directement dans le logiciel** (via `<webview>`) + génération de prompts par IA locale.

### Composants
- **Navigateur webview intégré** ouvrant `https://aistudio.google.com/` avec boutons de navigation (précédent/suivant/recharger/accueil), barre d'URL, et ouverture dans le navigateur externe.
- **Connexion Google** via une fenêtre dédiée (BrowserWindow) — le `<webview>` étant bloqué par Google pour l'OAuth, une vraie fenêtre partage la même session persistante (`persist:aistudio`).
- **Anti-détection Google** : User-Agent Chrome réel (sans « Electron »), masquage des Client Hints `sec-ch-ua`, override de `navigator.userAgentData` et `navigator.webdriver` via preload dédié.
- **Génération de prompts par Ollama (local)** — l'utilisateur fournit un domaine (PC/Hardware, GPU, Smartphones, Livres, Personnalisé), un objectif et des variables ; l'IA locale génère un prompt complet à coller dans AI Studio. Aucune IA sur le web, aucune clé API.
- **Test Ollama** intégré — bouton pour vérifier la connexion et lister les modèles installés.
- **Bouton ouvrir dossier des jobs** — accès direct au dossier de sortie.
- **Drag & drop .json** — glisser un fichier d'annonces dans le chat AI Studio.

### Fichiers
- `src/renderer/aiStudioModule.js` — logique renderer du module.
- `src/main/services/ai/promptGenerator.js` — génération de prompts via Ollama local.
- `src/main/aistudioLoginPreload.js` — preload anti-détection pour la fenêtre de connexion Google.

---

## 🏗️ Architecture technique

Architecture standard **Electron** (main + renderer) avec un **sous-processus** dédié au traitement lourd :

```
┌─────────────────────────────────────────────────────────────────┐
│                  PROCESSUS MAIN (Node.js)                        │
│  main.js → BrowserWindow + ipcHandlers                          │
│  ┌────────────┐   ┌───────────────┐   ┌────────────────┐        │
│  │ HarCapturer │   │ PipelineRunner │   │ MarketAnalyzer │        │
│  │ (Playwright)│──▶│ (fork process) │──▶│ (IA scoring)   │        │
│  └────────────┘   └───────────────┘   └────────────────┘        │
│       │                  │                    │                 │
│       ▼                  ▼                    ▼                 │
│   capture.har      annonces.json/csv/txt   marketAnalysis        │
│                                            → ExcelExporter      │
└─────────────────────────────────────────────────────────────────┘
                            ▲ IPC (ipcMain ↔ ipcRenderer) ▼
┌─────────────────────────────────────────────────────────────────┐
│                PROCESSUS RENDERER (Chromium, sandboxé)           │
│  index.html + app.js + styles.css + aiStudioModule.js            │
│  Exposé via preload.js (contextBridge → window.api)             │
└─────────────────────────────────────────────────────────────────┘
```

Le main suit une **architecture en couches** : `core/` (orchestration), `services/` (métier), `infrastructure/` (intégrations), `config/` (configuration), `utils/` (utilitaires).

### Pourquoi un sous-processus (`fork`) pour le pipeline ?

`leboncoin-pipeline.js` est un script CLI Node.js autonome lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler le traitement lourd (parsing de gros `.har`, jusqu'à plusieurs centaines de Mo) du main process pour ne pas geler l'UI ;
- de tuer/interrompre proprement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (logs formatés `[done/total]`).

---

## 📁 Structure du projet

```
leboncoin-scraper-app/
├── package.json                          # Métadonnées, dépendances, script "start"
├── test/
│   └── regression.test.js                # Suite de non-régression (269 assertions)
└── src/
    ├── main/                             # Processus principal Electron
    │   ├── main.js                       # Cycle de vie + fenêtres + session AI Studio
    │   ├── preload.js                    # Pont sécurisé Main ↔ Renderer (contextBridge)
    │   ├── widgetPreload.js              # Preload dédié au widget flottant
    │   ├── aistudioLoginPreload.js       # Preload anti-détection Google (fenêtre login)
    │   ├── core/
    │   │   ├── ipcHandlers.js            # Tous les handlers IPC
    │   │   └── settings.js               # Persistance user-settings.json
    │   ├── config/
    │   │   ├── constants.js              # Chemins, defaults, thèmes (require electron)
    │   │   ├── risk-keywords.js          # Mots-clés de risque (arnaques)
    │   │   ├── ai-cache.json             # Cache IA persistant
    │   │   ├── scheduled-tasks.json      # Tâches planifiées persistées
    │   │   └── user-settings.json        # Paramètres utilisateur
    │   ├── services/
    │   │   ├── scraping/
    │   │   │   ├── harCapturer.js         # Capture HAR via Playwright + pré-check captcha
    │   │   │   ├── pipelineRunner.js     # Lance le pipeline en fork + parse stdout
    │   │   │   ├── leboncoin-pipeline.js # CLI : HAR → annonces + enrichissement
    │   │   │   └── userAgents.js         # 10 User-Agents réalistes en rotation
    │   │   ├── ai/
    │   │   │   ├── marketAnalyzer.js     # Analyse IA par annonce (Ollama) + scoring
    │   │   │   ├── imageAnalyzer.js      # Analyse d'images IA Vision (Ollama LLaVA)
    │   │   │   ├── promptGenerator.js    # Génération de prompts via Ollama local
    │   │   │   ├── aiCache.js            # Cache IA (plafond 5000 + éviction)
    │   │   │   └── ollamaHealth.js       # Health-check Ollama
    │   │   ├── analysis/
    │   │   │   └── dealFinder.js         # Détection statistique affaires/risques
    │   │   ├── jobs/
    │   │   │   └── jobHistory.js         # Listing/lecture/suppression jobs (checksum)
    │   │   └── maintenance/
    │   │       └── storageCleaner.js     # Nettoyage .har + jobs (âge = timestamp dossier)
    │   ├── infrastructure/
    │   │   ├── excelExporter.js          # Export .xlsx stylisé (exceljs)
    │   │   ├── fileManager.js            # Ouverture fichiers/dossiers (explorateur)
    │   │   └── notifications.js          # Notifications système
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
        ├── app.js                        # Logique front-end
        ├── aiStudioModule.js             # Module Navigateur IA Studio
        ├── helpModule.js                 # Module d'aide (FAQ + guide + feedback)
        └── styles.css                    # Habillage + 13 thèmes + stat-cards
```

---

## 🧰 Stack technique

| Composant          | Technologie          | Rôle                                                         |
|--------------------|----------------------|--------------------------------------------------------------|
| Shell applicatif   | **Electron 28**      | App web comme application desktop native                      |
| Scraping           | **Playwright 1.41**  | Pilotage Chromium, capture réseau HAR                        |
| IA locale          | **Ollama**           | Analyse par annonce + génération de prompts (100% local)     |
| IA vision          | **Ollama LLaVA**     | Analyse d'images (optionnel)                                 |
| Export Excel       | **ExcelJS 4.4**      | Génération .xlsx stylisé                                     |
| Carte              | **Leaflet.js**       | Carte interactive des annonces                               |
| Graphiques         | **Chart.js**         | Distribution prix, vendeurs, top villes                       |
| Géocodage          | **API Gouv France**  | Coordonnées des villes (cache LocalStorage)                   |

---

## 🔄 Flux de fonctionnement

1. **Lancement** (`job:start`) → `HarCapturer` ouvre Chromium (headless), navigue vers Leboncoin.
2. **Pré-check captcha** : si blocage détecté (texte ou HTTP ≥400), ouverture d'une fenêtre visible pour résolution manuelle. Session validée persistée.
3. **Capture HAR** : navigation page par page, enregistrement du trafic filtré (`recherche|api|items`).
4. **Pipeline** (`fork`) : parse le HAR → extrait les annonces (`__NEXT_DATA__`) → normalise → déduplique → enrichit les descriptions (batchs parallèles + rate limiter).
5. **Analyse IA** (si activée) : `MarketAnalyzer.analyzeAds()` → pour chaque annonce, appel Ollama → scoring → `marketAnalysis`. Cache pour les re-analyses.
6. **Analyse d'images** (si activée) : `ImageAnalyzer.analyzeAll()` → télécharge 3 images → Ollama LLaVA → `imageAnalysis` + recalcul du score.
7. **Export** : `ExcelExporter.exportToXlsx()` → .xlsx stylisé + JSON/CSV/TXT.
8. **Notification** : si « Très bonne affaire » détectée, notification système native.
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

  // DealFinder (analyse statistique locale) :
  "dealTag": "GOOD",
  "dealDiscountPct": 22,
  "hasRisk": false,
  "detectedRisks": [],

  // MarketAnalyzer (analyse IA) :
  "marketAnalysis": {
    "productName": "PC Portable Gamer Ryzen 5 / RTX 3060",
    "classification": "Très bonne affaire",
    "askingPrice": 450,
    "marketAvg": 600,
    "marketMin": 510,
    "marketMax": 690,
    "diffEur": -150,
    "diffPct": -25,
    "confidence": "Élevé",
    "summary": "...",
    "netMarginEur": 95,
    "roiPct": 21,
    "scamScore": 12,
    "score": 84
  }
}
```

---

## 🏆 Algorithme de scoring

Score (0-100) calculé sur 7 critères (`marketAnalyzer.js → computeMarketValue()`) :

| Critère                                     | Points max |
|---------------------------------------------|-----------:|
| Écart de prix vs estimation marché          | 30         |
| Gamme du produit identifiée par l'IA        | 20         |
| État déclaré                                | 15         |
| Fiabilité de l'identification IA (non vague)| 20         |
| Marge de revente potentielle                | 10         |
| Confiance globale                           | 5          |
| **Malus** si annonce à risque               | **−20**    |

Classification : **≥80** 🟢 Très bonne affaire · **60-79** 🟢 Bonne affaire · **50-59** ⚪ Prix correct · **35-49** 🟠 Légèrement cher · **<35** 🔴 Trop cher.

L'analyse d'images (si activée) affine ensuite le score via `applyImageAnalysis()` : bonus/malus selon le type de photo, l'état visible et les défauts détectés.

---

## 🖥️ Interface utilisateur (onglets)

| Onglet | Description |
|---|---|
| 🚀 **Scraper** | Lancement d'un scraping (URL, pages, limite, proxy, config IA Ollama, options), presets 1-clic, progression temps réel. **Analyse auto du marché décochée par défaut** (à cocher manuellement). |
| 🌐 **AI Studio** | Navigateur intégré (Google AI Studio) + génération de prompts par Ollama local + test Ollama + bouton dossier jobs + drag & drop .json. |
| 📜 **Logs** | Console de logs en direct (info/warn/error/debug). |
| 📁 **Historique Jobs** | Liste des scrapings passés + accès fichiers + suppression. |
| 🔍 **Explorateur Annonces** | Filtres, tri, vue tableau/grille, fiche détaillée, comparateur, analyse marché manuelle. |
| 📊 **Statistiques & Carte** | 8 cartes colorées (Total, Prix Moyen/Médian/Min/Max, Main Propre, Pro/Particulier) + 3 graphiques (Distribution prix, Vendeurs, Top 10 Villes) + carte Leaflet. |

### ⚙️ Modale Paramètres

- **Thème** : 13 thèmes (aperçu temps réel).
- **Vitesse de scraping** : Rapide (10 parallèle, 0,5-1s) / Équilibré (5 parallèle, 1-2s) / Prudent (séquentiel, 1,5-3s).
- **Délai entre les pages** (ms, défaut 1000).
- **Mode de capture** : invisible (headless) ou visible.
- **Analyses IA simultanées** (parallélisme Ollama, défaut 5).
- **Nettoyage auto des .har** (jours, défaut 7).
- **Suppression auto des jobs** (optionnel, basée sur le timestamp du dossier).
- **Rétention des logs** (jours, défaut 7).

Paramètres persistés dans `config/user-settings.json`. Bouton **Réinitialiser** pour les valeurs par défaut.

---

## 🔌 Communication IPC

Le renderer n'a **aucun accès direct à Node.js** (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). Toute communication passe par `preload.js` → `window.api` → `ipcMain` dans `ipcHandlers.js`.

**21 canaux IPC** : `job:start/stop`, `market:analyze`, `prompt:generate`, `ollama:health/models`, `job:getHistory/delete`, `file:openFolder/openFile`, `shell:openExternal`, `config:get/save`, `secret:get/set/has/remove`, `network:check`, `aistudio:openLogin`, `widget:toggle/progress/status/close`, `log/progress/status`.

Les listeners utilisent `removeAllListeners` avant re-souscription pour éviter les fuites. Le getter `getMainWindow()` renvoie null si la fenêtre est détruite (pas de capture par closure).

---

## 🛡️ Anti-blocage & session

- **Session globale persistante** (`global-session.json`) : cookies validés réutilisés pour tous les jobs suivants.
- **Sauvegarde intelligente** : session globale sauvegardée dès la 1ère page réussie (HTTP <400), **jamais écrasée ensuite** (les 403 suivants ne corrompent pas la session).
- **Détection double** : marqueurs textuels (`captcha`, `robot`, `restreint`...) **ou** HTTP ≥400 (détecte les 403 silencieux).
- **Bascule fenêtre visible** si blocage au pré-check, reload toutes les 2s pour vérifier la levée.
- **Arrêt préventif** : un 403 pendant la capture arrête la boucle immédiatement.
- **Masquage `navigator.webdriver`**, UA Chrome réaliste, locale `fr-FR`.
- **Arrêt préventif enrichissement** après 3 blocages 403/429 consécutifs.
- **Support proxy** HTTP optionnel.
- **Recyclage mémoire** périodique du contexte navigateur.

---

## 🔒 Sécurité

- **Sandbox renderer** : `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (fenêtre principale + widget).
- **Path-traversal bloqué** : `isPathAllowed()` n'autorise que les chemins dans `BASE_OUT_DIR`.
- **`shell:openExternal` filtré** : seuls `http:`/`https:` sont autorisés (bloque `file:`, `javascript:`, `data:`).
- **Secrets chiffrés** : `safeStorage` OS (Keychain/DPAPI/libsecret) + fallback AES-256-GCM si indisponible. Clés API jamais en clair.
- **Intégrité des données** : checksum SHA-256 (`writeWithChecksum`/`readWithChecksum`), écriture atomique (`.tmp` + `rename`).
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
| Analyse par annonce + génération de prompts | **Ollama (local, gratuit)** | Onglet Scraper → URL + nom du modèle (ex: `llama3`). Health-check intégré. |
| Analyse d'images (optionnel) | **Ollama LLaVA** | Case à cocher « Analyser les images » + modèle vision. |

**OpenAI a été retiré** : l'IA se fait 100% en local via Ollama (aucune clé payante, hors-ligne). Aucune clé API n'est requise.

---

## 📦 Fichiers générés

Pour chaque job (`output/jobs/job-<timestamp>/`) :

| Fichier | Contenu |
|---|---|
| `capture.har` | Trace réseau brute |
| `session-state.json` | Cookies/session du job |
| `results/annonces.json` | Données structurées + analyse IA (checksum SHA-256) |
| `results/annonces.csv` | Export tabulaire |
| `results/annonces.txt` | Export texte lisible |
| `results/annonces.xlsx` | Export Excel stylisé |

---

## 🧪 Tests de non-régression

`test/regression.test.js` — script Node.js autonome (sans framework externe), **269 assertions** couvrant :

1. **utils/diagnostics.js** — helpers de log.
2. **Modules principaux** — MarketAnalyzer, DealFinder, StorageCleaner, SecretStore, settings.
3. **Pipeline via fork** — crée un faux HAR, lance le vrai pipeline, vérifie l'extraction.
4. **Corrections & renderer** — fixes présents (mapInstance, escapeHtml, stats, gestion 429).
5. **Architecture** — structure en couches, contrat IPC (21 canaux), widget, sandbox.
6. **Features** — intégrité SHA-256, rate limiting, logs rotatifs, health-check Ollama, secretStore, suppression auto jobs, mode hors-ligne, module AI Studio, module d'aide (FAQ/Help/Feedback).
7. **Audit fiabilité** — crash renderer (getAiApiKey), nettoyage jobs (timestamp), timeout géocodage, plafond cache IA.

### Exécuter

```bash
node test/regression.test.js
```

Résultat attendu : `=== RÉSULTAT : 269 réussis, 0 échoués ===`

> Le test installe des **stubs** pour `electron`, `playwright` et `exceljs` afin de `require()` les modules en Node pur, sans lancer Electron/Chromium.

---

## ⚠️ Limitations connues

- Le scraping repose sur la structure actuelle de Leboncoin (`__NEXT_DATA__`, endpoints de recherche) : toute évolution du site peut nécessiter une adaptation du parsing.
- La résolution de captcha reste **manuelle** (l'app ouvre une fenêtre visible et attend l'intervention humaine).
- L'analyse IA dépend de la qualité du modèle Ollama (`llama3` local peut être moins précis qu'un modèle cloud).
- L'enrichissement des descriptions est parallèle (10 simultanées) : en cas de 403, arrêt auto après 3 blocages et sauvegarde des données collectées.
- Un blocage IP déjà actif peut nécessiter d'attendre ou d'utiliser un proxy.
- La connexion Google dans AI Studio peut être bloquée par Google malgré l'anti-détection (UA spoofing, Client Hints, `navigator.userAgentData`).

---

## ⚖️ Avertissement légal

Cet outil interagit avec un site tiers (Leboncoin.fr) dont les [conditions d'utilisation](https://www.leboncoin.fr/) peuvent restreindre ou interdire le scraping automatisé. L'utilisation de cette application est sous l'entière responsabilité de l'utilisateur, qui doit s'assurer de respecter la législation applicable (RGPD pour les données de vendeurs particuliers, CGU du site) avant tout usage, notamment commercial.
