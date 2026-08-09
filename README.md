# 🛒 Leboncoin Scraper Pro

> ℹ️ **Note importante** : ce README a été généré à partir d'un instantané du code source à un instant donné. Depuis, le projet a pu évoluer : nouveaux modules ajoutés, fonctionnalités modifiées ou supprimées, refactoring de fichiers existants, changements de dépendances, etc. Ce document reste une **base de référence fiable sur l'architecture générale et la logique globale du projet**, mais en cas de doute sur un détail précis (nom de fonction, canal IPC, structure d'un fichier...), il est recommandé de vérifier directement dans le code source actuel plutôt que de se fier aveuglément à ce texte.

Application de bureau **Electron** permettant de scraper, enrichir, analyser (via IA) et exporter des annonces [Leboncoin.fr](https://www.leboncoin.fr) de manière semi-automatisée, avec détection de bonnes affaires, estimation de valeur marché, calcul de marge de revente et détection de risques/arnaques.

> Ce document est écrit pour permettre à une IA (ou à un développeur) sans aucune connaissance préalable du projet de comprendre entièrement son fonctionnement, son architecture et son code, sans avoir besoin d'autre contexte.

---

## 📋 Table des matières

1. [Vue d'ensemble](#-vue-densemble)
2. [Fonctionnalités principales](#-fonctionnalités-principales)
3. [Architecture technique](#-architecture-technique)
4. [Structure du projet](#-structure-du-projet)
5. [Stack technique](#-stack-technique)
6. [Flux de fonctionnement détaillé](#-flux-de-fonctionnement-détaillé)
7. [Le modèle de données "Annonce"](#-le-modèle-de-données-annonce)
8. [L'algorithme de scoring des affaires](#-lalgorithme-de-scoring-des-affaires)
9. [Interface utilisateur (onglets)](#-interface-utilisateur-onglets)
10. [Communication IPC (Main ↔ Renderer)](#-communication-ipc-main--renderer)
11. [Anti-blocage & gestion de session](#-anti-blocage--gestion-de-session)
12. [Installation & lancement](#-installation--lancement)
13. [Configuration de l'IA](#-configuration-de-lia)
14. [Fichiers générés (sorties)](#-fichiers-générés-sorties)
15. [Limitations connues](#-limitations-connues)
16. [Avertissement légal](#-avertissement-légal)

---

## 🎯 Vue d'ensemble

**Leboncoin Scraper Pro** est une application desktop (Windows/Mac/Linux) construite avec **Electron**, dont le but est de :

1. **Capturer** les résultats d'une recherche Leboncoin (via un navigateur Chromium piloté par Playwright).
2. **Extraire** les annonces à partir du trafic réseau capturé (fichier `.har`).
3. **Enrichir** chaque annonce avec sa description complète (non présente dans les résultats de recherche bruts).
4. **Analyser le marché** via une IA (locale via Ollama, ou distante via OpenAI) pour estimer si le prix demandé est une bonne affaire, une arnaque potentielle, ou un prix correct.
5. **Exporter** les résultats en JSON, CSV, TXT et Excel (`.xlsx`) formaté avec mise en forme conditionnelle.
6. Offrir une interface complète de **pilotage, planification, historique, exploration, comparaison et visualisation cartographique/statistique** des annonces collectées.

L'application est pensée pour un usage **semi-automatisé** : l'utilisateur peut devoir résoudre un captcha manuellement si Leboncoin détecte une activité robotique, après quoi le scraping reprend automatiquement.

---

## ⚙️ Fonctionnalités principales

- 🚀 **Scraping automatisé** d'une URL de recherche Leboncoin sur plusieurs pages.
- 🔑 **Session globale persistante** ("Master Session") pour éviter de repasser un captcha à chaque lancement.
- 🤖 **Détection automatique de blocage/captcha** avec pause et reprise après résolution manuelle.
- 📝 **Extraction des descriptions complètes** des annonces en mode "Turbo" (requêtes HTTP par batchs de 10, exécutées directement dans la page pour hériter des cookies/session).
- 🧠 **Analyse IA par annonce** (`marketAnalyzer.js`) : identification du produit, gamme, état, type de photo, puis calcul d'un **score de 0 à 100**, d'une **classification** (Très bonne affaire / Bonne affaire / Prix correct / Légèrement cher / Trop cher), d'une **marge de revente estimée (ROI)** et d'un **score d'arnaque (scam score)**.
- 🧠 **Analyse Globale IA (Gemini)** : un moteur d'analyse "grand contexte" (Gemini 2.0 Flash, jusqu'à 1M tokens) capable d'analyser l'ensemble d'un job en une fois pour produire un classement des meilleures opportunités avec instructions personnalisées.
- 📊 **Export Excel (.xlsx)** stylisé (couleurs, filtres automatiques, liens hypertextes, mise en forme conditionnelle des bonnes/mauvaises affaires) via `exceljs`.
- 📄 Export **JSON, CSV et TXT** lisible.
- ⏰ **Planificateur de tâches** (scraping récurrent à intervalle défini en minutes) avec notifications Windows natives lors de la découverte d'une "Très bonne affaire".
- 📁 **Historique complet des jobs** de scraping (annonces, statistiques, fichiers générés) avec suppression.
- 🔍 **Explorateur d'annonces** avec filtres (mot-clé, prix min/max, tag de deal), tri, vue tableau/grille, fiche détaillée par annonce (galerie photo, résumé IA, marge, etc.).
- 🆚 **Comparateur d'annonces** côte à côte.
- 📊 **Statistiques & carte interactive** (Leaflet.js) affichant la répartition géographique des annonces en France, graphiques (Chart.js) de répartition des deals et des vendeurs.
- 📌 **Presets de recherche** réutilisables en un clic.
- 🖥️ **Widget flottant** pour suivre la progression sans garder la fenêtre principale au premier plan.
- 🎨 **6 thèmes visuels** (Sombre, Clair, OLED, Bleu Ocean, Vert Émeraude, Violet Cyberpunk).
- 🌐 **Support proxy rotatif** optionnel (HTTP proxy avec authentification).
- 🧹 **Nettoyage automatique** des anciens fichiers `.har` (configurable, par défaut 7 jours) pour limiter l'usage disque.

---

## 🏗️ Architecture technique

L'application suit l'architecture standard **Electron** en deux processus séparés, avec un **sous-processus additionnel** dédié au traitement lourd des données :

```
┌─────────────────────────────────────────────────────────────────┐
│                        PROCESSUS MAIN (Node.js)                  │
│  src/main/main.js  →  crée la BrowserWindow + charge ipcHandlers │
│                                                                     │
│  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐ │
│  │ HarCapturer   │   │ PipelineRunner    │   │ MarketAnalyzer    │ │
│  │ (Playwright)  │──▶│ (fork process)    │──▶│ (IA scoring)      │ │
│  └───────────────┘   └──────────────────┘   └──────────────────┘ │
│         │                     │                       │           │
│         ▼                     ▼                       ▼           │
│   capture.har        annonces.json/.csv/.txt    marketAnalysis    │
│                                                         │           │
│                                              ┌──────────────────┐  │
│                                              │  ExcelExporter    │  │
│                                              └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲  IPC (ipcMain / ipcRenderer)  │
                              │                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PROCESSUS RENDERER (Chromium)                 │
│   src/renderer/index.html + app.js + styles.css                  │
│   Exposé au renderer via preload.js (contextBridge → window.api) │
└─────────────────────────────────────────────────────────────────┘
```

### Pourquoi un sous-processus (`fork`) séparé pour le pipeline ?

Le fichier `src/main/vendor/leboncoin-pipeline.js` est un **script CLI Node.js autonome** (utilisable aussi en ligne de commande) lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler un traitement potentiellement lourd (parsing de très gros fichiers `.har`, jusqu'à plusieurs centaines de Mo) du processus principal Electron pour ne pas geler l'UI ;
- de pouvoir tuer/interrompre proprement le traitement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (parsing de logs formatés `[done/total]`).

---

## 📁 Structure du projet

```
leboncoin-scraper-app/
├── package.json                          # Métadonnées, dépendances, script "start"
└── src/
    ├── main/                             # Processus principal Electron (Node.js)
    │   ├── main.js                       # Point d'entrée : crée la fenêtre Electron
    │   ├── preload.js                    # Pont sécurisé (contextBridge) Main ↔ Renderer
    │   ├── ipcHandlers.js                # Tous les gestionnaires d'événements IPC
    │   ├── config/
    │   │   └── constants.js              # Constantes globales (chemins, thèmes, mots-clés à risque)
    │   ├── utils/
    │   │   └── helpers.js                # sleep, randomDelay, écriture atomique, formatDuration...
    │   ├── vendor/
    │   │   └── leboncoin-pipeline.js     # Script CLI autonome : HAR → JSON/CSV/TXT + enrichissement
    │   └── modules/
    │       ├── harCapturer.js            # Capture du trafic réseau via Playwright/Chromium
    │       ├── pipelineRunner.js         # Lance leboncoin-pipeline.js en sous-processus (fork)
    │       ├── dealFinder.js             # Détection statistique de bonnes affaires / annonces à risque
    │       ├── marketAnalyzer.js         # Analyse IA par annonce : score, classification, ROI, scam score
    │       ├── aiAnalyzer.js             # Résumé IA générique par annonce (OpenAI / Ollama)
    │       ├── excelExporter.js          # Génération du fichier .xlsx stylisé (exceljs)
    │       ├── fileManager.js            # Ouverture de fichiers/dossiers dans l'explorateur système
    │       ├── jobHistory.js             # Listing, lecture et suppression des jobs passés
    │       ├── jobScheduler.js           # Planification de scrapings récurrents + notifications
    │       └── storageCleaner.js         # Nettoyage des anciens fichiers .har
    └── renderer/                         # Interface utilisateur (front-end, sandboxé)
        ├── index.html                    # Structure de l'UI (onglets, modales, formulaires)
        ├── app.js                        # Logique front-end (événements, rendu dynamique, appels API)
        └── styles.css                    # Habillage visuel + thèmes
```

---

## 🧰 Stack technique

| Composant          | Technologie                          | Rôle                                                        |
|---------------------|---------------------------------------|---------------------------------------------------------------|
| Shell applicatif    | **Electron 28**                       | Fait tourner une app web comme une application desktop native |
| Navigation & scraping | **Playwright 1.41.2** (Chromium)   | Pilote un vrai navigateur pour capturer le trafic réseau (HAR) et contourner les protections anti-bot basiques |
| Export Excel        | **ExcelJS 4.4**                       | Génère des fichiers `.xlsx` avec mise en forme, filtres, liens |
| Cartographie         | **Leaflet.js** (CDN)                 | Carte interactive de France pour géolocaliser les annonces |
| Graphiques           | **Chart.js** (CDN)                   | Statistiques visuelles (répartition des deals, vendeurs)   |
| IA locale            | **Ollama** (`llama3` par défaut, HTTP local `127.0.0.1:11434`) | Analyse IA gratuite/hors-ligne des annonces |
| IA distante (option) | **OpenAI API** (`gpt-4o-mini` par défaut) | Alternative payante à Ollama pour l'analyse par annonce |
| IA "Analyse Globale" | **Google Gemini** (`gemini-2.0-flash`, clé gratuite Google AI Studio) | Analyse contextuelle de l'ensemble d'un job (classement des meilleures opportunités) |
| Runtime              | **Node.js** (via Electron)            | Exécution du processus main et du pipeline en sous-processus |

---

## 🔄 Flux de fonctionnement détaillé

Voici le cycle de vie complet d'un scraping, du clic sur "Démarrer" jusqu'au fichier Excel final :

### Étape 1 — Capture HAR (`HarCapturer`, via Playwright)
- Lance un navigateur **Chromium headless**.
- Charge la **session globale** (`global-session.json`) si elle existe, pour réutiliser les cookies déjà validés et éviter un nouveau captcha.
- Navigue sur l'URL de recherche fournie, page par page (paramètre `page=N` ajouté automatiquement à l'URL).
- Enregistre **tout le trafic réseau** correspondant aux appels d'API/recherche dans un fichier `capture.har` (`recordHar` de Playwright, filtré sur `recherche|api|items`).
- **Détecte les blocages** (captcha, "vitesse surhumaine", mention "robot"/"restreint") en inspectant le titre et le texte visible de la page. Si un blocage est détecté, l'app **attend indéfiniment** que l'utilisateur résolve manuellement le captcha (vérification toutes les 2 secondes) avant de continuer.
- Recycle la page toutes les 3 pages pour limiter la consommation mémoire.
- À la fin, sauvegarde les cookies/session validés dans `global-session.json` (session partagée entre tous les futurs jobs) et dans une session locale au job.

### Étape 2 — Extraction & enrichissement (`PipelineRunner` → `leboncoin-pipeline.js`, en sous-processus)
1. **Parsing du HAR** : lecture de toutes les réponses HTTP au format JSON (ou JSON embarqué dans un `<script id="__NEXT_DATA__">` d'une page HTML).
2. **Recherche récursive** (parcours itératif type DFS avec une pile, limité à 500 000 nœuds visités) de tout objet "ressemblant à une annonce" (présence d'un identifiant, d'un titre, d'un prix ou d'une URL).
3. **Normalisation** de chaque annonce brute vers un modèle de données unifié (voir section suivante).
4. **Fusion des doublons** par identifiant d'annonce.
5. **Écriture atomique** des résultats intermédiaires (`annonces.json`, `annonces.txt`, `annonces.csv` si activé) — écriture dans un fichier temporaire puis renommage, pour éviter la corruption en cas de crash.
6. **Enrichissement des descriptions** (`DescriptionEnricher`) : les résultats de recherche Leboncoin ne contiennent pas toujours la description complète. Le pipeline :
   - relance un navigateur Chromium (avec session existante, images/CSS bloquées pour la vitesse) ;
   - envoie des requêtes `fetch()` **directement depuis la page** (pour hériter des cookies du navigateur) vers chaque URL d'annonce, **par batchs de 10 en parallèle** ("Turbo-Mode") ;
   - parse le HTML retourné pour en extraire la description via le JSON `__NEXT_DATA__` ;
   - **s'arrête préventivement** après 3 blocages HTTP 403/429 consécutifs, pour éviter un bannissement IP, et sauvegarde immédiatement la progression déjà acquise ;
   - sauvegarde périodiquement (tous les 10 items) et recycle le contexte navigateur tous les 200 items traités.
7. Le script s'exécute en tant que **CLI indépendant**, communique sa progression au processus parent via des lignes de log formatées `[done/total]` sur `stdout`, capturées et retransmises à l'UI par `PipelineRunner`.

### Étape 3 — Analyse de marché IA (`MarketAnalyzer`, optionnelle mais activée par défaut)
Pour chaque annonce :
1. Un **prompt IA** (Ollama local ou OpenAI) demande d'identifier précisément le produit, sa gamme (`ENTREE_DE_GAMME` / `MILIEU_DE_GAMME` / `HAUT_DE_GAMME`), son état réel, le type de photo (authentique ou photo constructeur), et si l'annonce est trop vague pour être fiable (`isVague`).
2. La fonction `computeMarketValue()` calcule ensuite, à partir de la **médiane des prix du dataset complet** et d'un multiplicateur dépendant de la gamme identifiée :
   - une **estimation de valeur marché** (moyenne, min, max) ;
   - l'**écart** entre le prix demandé et l'estimation (en € et en %) ;
   - une **marge de revente nette estimée** et un **ROI (%)** (en déduisant des frais estimés de ~8% + 4,90€) ;
   - un **score d'arnaque** (`scamScore`, 0-99) basé sur un écart de prix anormalement bas, l'absence de livraison, une annonce vague, ou une photo "constructeur" ;
   - un **score global sur 100 points** combinant : écart de prix vs marché (30 pts), gamme du produit (20 pts), état (15 pts), fiabilité de l'estimation IA (20 pts), marge potentielle (10 pts), confiance de l'analyse (5 pts), avec un **malus de -20 points** si l'annonce est signalée à risque (mots-clés comme "HS", "pour pièces", "cassé", etc. — voir `RISK_KEYWORDS` dans `constants.js`).
   - une **classification finale** : `Très bonne affaire` (≥80), `Bonne affaire` (≥60), `Prix correct` (50-59), `Légèrement cher` (35-49), `Trop cher` (<35).

### Étape 4 — Export
- Les résultats enrichis sont réécrits dans `annonces.json`.
- Un fichier **Excel (.xlsx)** est généré (`ExcelExporter`) avec 14 colonnes (ID, titre, prix, classification, prix moyen marché, fourchette, écarts, indice de confiance, résumé, ville, vendeur, date, lien hypertexte cliquable), en-tête stylisé, couleurs conditionnelles (vert pour les bonnes affaires, rouge pour "Trop cher") et filtres automatiques activés.
- Si une ou plusieurs annonces sont classées **"Très bonne affaire"**, une **notification système Windows** est envoyée automatiquement.

### Étape 5 — Analyse Globale IA (à la demande, séparée)
Depuis l'onglet dédié, l'utilisateur peut lancer une **analyse globale** d'un job entier via l'API **Google Gemini** (modèle `gemini-2.0-flash`, clé API gratuite Google AI Studio). Contrairement à l'analyse par annonce, celle-ci traite **l'ensemble du dataset en un seul appel** (profitant de la grande fenêtre de contexte de Gemini) pour produire :
- des indicateurs clés (nombre d'annonces analysées, meilleure affaire, profit potentiel total) ;
- une synthèse stratégique en langage naturel ;
- un **classement (top ranking)** des meilleures opportunités avec justification IA pour chacune.
- L'utilisateur peut fournir une **instruction personnalisée** (ex : *"Trouve les 5 meilleures cartes graphiques à moins de 80€"*) pour orienter l'analyse.

---

## 🗂️ Le modèle de données "Annonce"

Chaque annonce, une fois normalisée par le pipeline, suit cette structure (dans `annonces.json`) :

```jsonc
{
  "id": "2831923847",                 // identifiant unique Leboncoin
  "title": "PC portable Gamer",
  "price": 450,
  "description": "Texte complet de l'annonce...",
  "url": "https://www.leboncoin.fr/ad/2831923847.htm",
  "images": ["https://...jpg", "..."],
  "main_image": "https://...jpg",
  "city": "Lyon",
  "zipcode": "69000",
  "shipping": true,
  "seller": "Jean D.",
  "isPro": false,
  "date": "2026-08-01T10:00:00Z",
  "category": "Informatique",

  // Ajouté par DealFinder (analyse statistique locale) :
  "dealTag": "GOOD",                  // GOOD | NORMAL | HIGH
  "dealDiscountPct": 22,
  "hasRisk": false,
  "detectedRisks": [],

  // Ajouté par MarketAnalyzer (analyse IA) :
  "marketAnalysis": {
    "productName": "PC Portable Gamer Ryzen 5 / RTX 3060",
    "classification": "Très bonne affaire",
    "badgeClass": "tag-deal-super",
    "askingPrice": 450,
    "marketMin": 510,
    "marketMax": 690,
    "marketAvg": 600,
    "diffEur": -150,
    "diffPct": -25,
    "confidence": "Élevé",
    "summary": "...",
    "netMarginEur": 95,
    "roiPct": 21,
    "scamScore": 12,
    "photoType": "AUTHENTIQUE",
    "score": 84
  }
}
```

---

## 🏆 L'algorithme de scoring des affaires

Le score (0 à 100) est calculé sur 7 critères pondérés (voir `marketAnalyzer.js → computeMarketValue()`) :

| Critère                                            | Points max |
|-----------------------------------------------------|-----------:|
| Écart de prix vs estimation marché                  | 30         |
| Gamme du produit identifiée par l'IA                | 20         |
| État déclaré du produit                              | 15         |
| Fiabilité de l'identification IA (non vague)        | 20         |
| Marge de revente potentielle (marge + ROI)          | 10         |
| Confiance globale de l'analyse                       | 5          |
| **Malus** si annonce à risque (HS, pour pièces...)  | **−20**    |

Classification résultante :
- **≥ 80** → 🟢 Très bonne affaire
- **60-79** → 🟢 Bonne affaire
- **50-59** → ⚪ Prix correct
- **35-49** → 🟠 Légèrement cher
- **< 35** → 🔴 Trop cher

---

## 🖥️ Interface utilisateur (onglets)

| Onglet | Description |
|---|---|
| 🚀 **Scraper** | Formulaire de lancement d'un scraping (URL, nombre de pages, limite, proxy, config IA, options CSV/description), presets de recherche 1-clic, barre de progression et statut en temps réel. |
| 🧠 **Analyse Globale IA** | Sélection d'un job existant, saisie d'une clé API Gemini, instructions personnalisées ou presets d'analyse, affichage de KPIs et d'un classement des meilleures opportunités. |
| ⏰ **Planificateur** | Création de scrapings récurrents (URL + intervalle en minutes) avec liste des tâches actives. |
| 📜 **Logs** | Console de logs en direct (info/warn/error/debug) de toutes les étapes du scraping. |
| 📁 **Historique Jobs** | Liste de tous les scrapings passés avec accès direct aux fichiers générés et suppression. |
| 🔍 **Explorateur Annonces** | Recherche/filtrage (mot-clé, prix, tag de deal), tri, vue tableau ou grille, fiche détaillée par annonce (galerie photo, résumé IA, badge de deal), comparateur côte-à-côte, lancement manuel de l'analyse marché. |
| 📊 **Statistiques & Carte** | KPIs (bonnes affaires, risques, total d'annonces), carte interactive Leaflet des annonces en France (avec filtre "remise en main propre uniquement"), graphiques Chart.js de répartition des deals et des vendeurs. |

D'autres éléments transverses : sélecteur de **thème** (6 thèmes), bouton **widget flottant**, modale de **paramètres globaux** (durée de rétention des fichiers `.har`).

---

## 🔌 Communication IPC (Main ↔ Renderer)

Le renderer n'a **aucun accès direct à Node.js** (`contextIsolation: true`, `nodeIntegration: false`) : toute communication passe par le pont sécurisé exposé dans `preload.js` sous `window.api`, qui relaie vers `ipcMain` dans `ipcHandlers.js` :

| Méthode `window.api` | Canal IPC | Rôle |
|---|---|---|
| `startScraping(config)` | `job:start` (send) | Démarre un scraping complet (capture → pipeline → IA → export) |
| `stopScraping()` | `job:stop` (send) | Interrompt le scraping en cours proprement |
| `onLog(cb)` / `onProgress(cb)` / `onStatusChange(cb)` | `log` / `progress` / `status` | Écoute des événements temps réel envoyés par le main process |
| `analyzeMarket(data)` | `market:analyze` (invoke) | Relance une analyse IA sur un job existant |
| `onSchedulerTrigger(cb)` | `scheduler:trigger` | Notifie le renderer qu'une tâche planifiée démarre |
| `addSchedule` / `removeSchedule` / `listSchedules` | `scheduler:add/remove/list` | Gestion du planificateur |
| `getHistory()` / `deleteJob(id)` | `job:getHistory` / `job:delete` | Gestion de l'historique des jobs |
| `openFolder(path)` / `openFile(path)` | `file:openFolder` / `file:openFile` | Ouvre un fichier/dossier dans l'explorateur système natif |

> Note : l'analyse globale Gemini (`analyzeGlobalDataset`) est pilotée depuis le renderer mais son point d'entrée exact côté `ipcHandlers.js`/`preload.js` fait partie du module d'analyse globale du projet — à vérifier/compléter selon la version du code source si ce canal n'apparaît pas explicitement dans `preload.js`.

---

## 🛡️ Anti-blocage & gestion de session

L'application intègre plusieurs mécanismes pour limiter les risques de blocage par Leboncoin :

- **Session globale persistante** (`global-session.json`, stockée dans `Documents/Leboncoin Scraper Pro/` en version packagée) : les cookies validés (notamment après résolution d'un captcha) sont réutilisés pour tous les jobs suivants.
- **Détection de blocage en temps réel** : recherche de marqueurs (`captcha`, `robot`, `restreint`, `vitesse surhumaine`, `captcha-delivery`) dans le titre/texte de la page, avec pause automatique jusqu'à résolution manuelle par l'utilisateur.
- **Masquage de l'empreinte "webdriver"** (`navigator.webdriver = undefined`) pour réduire la détection d'automatisation.
- **User-Agent réaliste** (Chrome Windows) et **locale `fr-FR`** fixés sur tous les contextes navigateur.
- **Délais aléatoires** (jitter) entre les requêtes, avec des plages différentes pour la capture de pages (2,5-4,5s) et l'enrichissement en batch (0,5-1s + jitter).
- **Arrêt préventif automatique** après 3 réponses HTTP 403/429 consécutives lors de l'enrichissement des descriptions, pour éviter un bannissement IP prolongé — les données déjà collectées sont sauvegardées.
- **Support de proxy HTTP rotatif** optionnel (avec authentification).
- **Recyclage périodique du navigateur/contexte** pour limiter la consommation mémoire sur de gros volumes.

---

## 🚀 Installation & lancement

### Prérequis
- [Node.js](https://nodejs.org/) (version récente recommandée)
- npm

### Installation

```bash
npm install
```

Cette commande installe les dépendances, dont **Electron** et **Playwright**. Playwright peut nécessiter l'installation des navigateurs Chromium associés :

```bash
npx playwright install chromium
```

### Lancement

```bash
npm start
```

Cela exécute la commande définie dans `package.json` :
```json
"start": "electron --max-old-space-size=8192 ."
```
(la mémoire allouée à V8 est augmentée à 8 Go pour supporter le traitement de gros fichiers `.har`).

### Emplacement des fichiers de sortie
- **En développement** : `./output/` (dossier local du projet).
- **En version packagée (.exe)** : `Documents/Leboncoin Scraper Pro/` de l'utilisateur.

---

## 🤖 Configuration de l'IA

L'application utilise **trois usages distincts de l'IA**, chacun configurable indépendamment :

1. **Analyse par annonce (`marketAnalyzer.js` / `aiAnalyzer.js`)** — choix entre :
   - **Ollama (local, gratuit, hors-ligne)** : nécessite qu'[Ollama](https://ollama.com) tourne en local (`http://127.0.0.1:11434` par défaut) avec un modèle téléchargé (ex : `llama3`).
   - **OpenAI (cloud, payant)** : nécessite une clé API OpenAI (`sk-...`), modèle par défaut `gpt-4o-mini`.
2. **Analyse Globale (Gemini)** — nécessite une clé API **Google AI Studio** (gratuite), modèle `gemini-2.0-flash`.

Les clés API et préférences (proxy, clé Gemini) sont conservées dans le `localStorage` du renderer pour éviter de les ressaisir à chaque session.

---

## 📦 Fichiers générés (sorties)

Pour chaque job de scraping (`output/jobs/job-<timestamp>/`) :

| Fichier | Contenu |
|---|---|
| `capture.har` | Trace réseau brute capturée par Playwright |
| `session-state.json` | Cookies/session Playwright propres à ce job |
| `results/annonces.json` | Données structurées complètes (avec analyse IA/marché) |
| `results/annonces.csv` | Export tabulaire simplifié |
| `results/annonces.txt` | Export texte lisible, une fiche par annonce |
| `results/annonces.xlsx` | Export Excel stylisé avec mise en forme conditionnelle |

---

## ⚠️ Limitations connues

- Le scraping de Leboncoin repose sur la structure actuelle de leurs pages/API (`__NEXT_DATA__`, endpoints de recherche) : toute évolution significative du site peut nécessiter une adaptation du parsing (`leboncoin-pipeline.js`).
- La résolution de captcha reste **manuelle** (l'app ne la contourne pas automatiquement, elle attend l'intervention humaine).
- L'analyse IA (marché, scoring, résumé) dépend de la qualité du modèle utilisé (un modèle local léger comme `llama3` peut être moins précis qu'un modèle cloud).
- Le mode "Turbo" (10 requêtes en parallèle) accélère fortement l'enrichissement mais augmente le risque de blocage — l'app compense avec un arrêt préventif automatique.

---

## ⚖️ Avertissement légal

Cet outil interagit avec un site tiers (Leboncoin.fr) dont les [conditions générales d'utilisation](https://www.leboncoin.fr/) peuvent restreindre ou interdire le scraping automatisé. L'utilisation de cette application est sous l'entière responsabilité de l'utilisateur, qui doit s'assurer de respecter la législation applicable (notamment concernant la protection des données personnelles, le RGPD pour les données de vendeurs particuliers, et les CGU du site ciblé) avant tout usage, en particulier à des fins commerciales.
