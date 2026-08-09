# 🛒 Leboncoin Scraper Pro

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
15. [Tests de non-régression](#-tests-de-non-régression)
16. [Limitations connues](#-limitations-connues)
17. [Avertissement légal](#-avertissement-légal)

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
- 📝 **Extraction des descriptions complètes** des annonces en mode rapide parallèle (10 requêtes HTTP simultanées par batch via `Promise.all`, exécutées directement dans la page pour hériter des cookies/session).
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
- 🖥️ **Widget flottant** always-on-top pour suivre la progression du scraping en temps réel, même fenêtre principale minimisée (pourcentage, barre de progression, statut, point coloré animé).
- 🎨 **13 thèmes visuels** (Sombre, Clair, OLED, Violet Doux, Vert Émeraude, Sunset, Carbon, Rose, Amber, Mint, Slate, Crimson, Nordic) — réglables depuis la modale Paramètres.
- 🌐 **Support proxy rotatif** optionnel (HTTP proxy avec authentification).
- 🚀 **3 presets de vitesse** (Rapide / Équilibré / Prudent) réglables dans les Paramètres, du parallèle agressif au séquentiel anti-blocage.
- 🧠 **Cache IA** — les annonces déjà analysées (même `list_id`) ne sont pas re-demandées à l'IA. Accélération massive sur les scrapings répétés.
- 🔄 **Rotation de User-Agent** — 10 User-Agents réalistes en rotation aléatoire pour réduire la détection.
- 💾 **Persistance des tâches planifiées** — les tâches du planificateur survivent au redémarrage de l'application.
- 🔍 **Filtres mémorisés** — les filtres de l'Explorateur Annonces (mot-clé, prix, tri) sont sauvegardés entre les sessions.
- 📦 **Extraction livraison** — l'info "remise en main propre / livraison" est extraite depuis les pages individuelles d'annonces (Leboncoin ne la fournit pas dans les résultats de recherche).
- 🧹 **Nettoyage automatique** des anciens fichiers `.har` (configurable, par défaut 7 jours) pour limiter l'usage disque.

---

## 🏗️ Architecture technique

L'application suit l'architecture standard **Electron** en deux processus séparés, avec un **sous-processus additionnel** dédié au traitement lourd des données :

```
┌─────────────────────────────────────────────────────────────────┐
│                        PROCESSUS MAIN (Node.js)                  │
│  src/main/main.js  →  crée la BrowserWindow + charge core/ipcHandlers │
│                                                                     │
│  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐ │
│  │ HarCapturer   │   │ PipelineRunner    │   │ MarketAnalyzer    │ │
│  │ (Playwright)  │──▶│ (fork process)    │──▶│ (IA scoring)      │ │
│  └───────────────┘   └──────────────────┘   └──────────────────┘ │
│  services/scraping/      services/scraping/      services/ai/      │
│         │                     │                       │           │
│         ▼                     ▼                       ▼           │
│   capture.har        annonces.json/.csv/.txt    marketAnalysis    │
│                                                         │           │
│                                              ┌──────────────────┐  │
│                                              │  ExcelExporter    │  │
│                                              │  infrastructure/  │  │
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

Le processus main suit une **architecture en couches** (`core/` orchestration, `services/` logique métier, `infrastructure/` intégrations externes, `config/` configuration, `utils/` utilitaires) — voir la section *Structure du projet* ci-dessous.

### Pourquoi un sous-processus (`fork`) séparé pour le pipeline ?

Le fichier `src/main/services/scraping/leboncoin-pipeline.js` est un **script CLI Node.js autonome** (utilisable aussi en ligne de commande) lancé via `child_process.fork()` depuis `pipelineRunner.js`. Cela permet :
- d'isoler un traitement potentiellement lourd (parsing de très gros fichiers `.har`, jusqu'à plusieurs centaines de Mo) du processus principal Electron pour ne pas geler l'UI ;
- de pouvoir tuer/interrompre proprement le traitement (`SIGINT`) sans affecter Electron ;
- de communiquer la progression via `stdout` (parsing de logs formatés `[done/total]`).

---

## 📁 Structure du projet

```
leboncoin-scraper-app/
├── package.json                          # Métadonnées, dépendances, script "start"
├── test/
│   └── regression.test.js                # Suite de non-régression (109 assertions)
└── src/
    ├── main/                             # Processus principal Electron (Node.js)
    │   ├── main.js                       # Point d'entrée : cycle de vie app + fenêtre principale + fenêtre widget
    │   ├── preload.js                    # Pont sécurisé (contextBridge) Main ↔ Renderer
    │   ├── core/                         # Cœur applicatif (orchestration)
    │   │   ├── ipcHandlers.js            # Routage IPC uniquement (délègue aux services)
    │   │   └── settings.js               # Persistance des paramètres utilisateur
    │   ├── config/                       # Configuration
    │   │   ├── constants.js              # Chemins, defaults, thèmes
    │   │   └── risk-keywords.js          # Mots-clés à risque (logique métier isolée)
    │   ├── services/                     # Services métier (par domaine)
    │   │   ├── scraping/                 # Couche de scraping
    │   │   │   ├── harCapturer.js        # Capture du trafic réseau via Playwright/Chromium
    │   │   │   ├── pipelineRunner.js     # Lance leboncoin-pipeline.js en sous-processus (fork)
    │   │   │   └── leboncoin-pipeline.js # Script CLI : HAR → JSON/CSV/TXT + enrichissement
    │   │   ├── ai/                       # Couche d'analyse IA
    │   │   │   ├── marketAnalyzer.js     # Analyse IA par annonce (Ollama / OpenAI)
    │   │   │   └── globalAnalyzer.js     # Analyse globale du dataset (Google Gemini)
    │   │   ├── analysis/                 # Couche d'analyse statistique
    │   │   │   └── dealFinder.js         # Détection bonnes affaires / annonces à risque
    │   │   ├── jobs/                     # Gestion des jobs
    │   │   │   ├── jobHistory.js         # Listing, lecture, suppression des jobs passés
    │   │   │   └── jobScheduler.js       # Planification de scrapings récurrents
    │   │   └── maintenance/              # Maintenance
    │   │       └── storageCleaner.js     # Nettoyage des anciens fichiers .har
    │   ├── infrastructure/               # Intégrations externes / OS
    │   │   ├── excelExporter.js          # Génération du fichier .xlsx stylisé (exceljs)
    │   │   ├── fileManager.js            # Ouverture de fichiers/dossiers (explorateur système)
    │   │   └── notifications.js          # Notifications système (Electron Notification)
    │   └── utils/                        # Utilitaires transverses
    │       ├── helpers.js                # sleep, randomDelay, écriture atomique, formatDuration...
    │       └── diagnostics.js            # Helpers de log/diagnostic (redact, formatBytes…)
    └── renderer/                         # Interface utilisateur (front-end, sandboxé)
        ├── index.html                    # Structure de l'UI (onglets, modales, formulaires)
        ├── widget.html                   # Widget flottant always-on-top (progression temps réel)
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

### Étape 1 — Pré-check & Capture HAR (`HarCapturer`, via Playwright)
- **Pré-check** : lance un navigateur **Chromium headless**, charge la **session globale** (`global-session.json`) si elle existe, navigue sur l'URL de recherche. Si la page retourne un code HTTP ≥ 400 (403/429) ou si un CAPTCHA est détecté dans le texte → **bascule en navigateur visible** pour résolution manuelle. Le navigateur visible recharge la page toutes les 2 secondes jusqu'à ce que le blocage soit levé. La session validée est ensuite sauvegardée.
- **Capture** : navigue sur l'URL de recherche, page par page (paramètre `page=N` ajouté automatiquement à l'URL).
- Enregistre **tout le trafic réseau** correspondant aux appels d'API/recherche dans un fichier `capture.har` (`recordHar` de Playwright, filtré sur `recherche|api|items`).
- **Sauvegarde la session globale dès la 1ère page réussie** (HTTP < 400) — ne l'écrase plus ensuite pour éviter de corrompre la session avec des cookies anti-bot des pages suivantes.
- **Arrêt immédiat** si une page retourne un 403 pendant la capture, au lieu de continuer sur les pages suivantes.
- Recycle la page toutes les 3 pages pour limiter la consommation mémoire.
- À la fin, sauvegarde une session locale au job (`session-state.json`) pour le pipeline d'enrichissement.

### Étape 2 — Extraction & enrichissement (`PipelineRunner` → `leboncoin-pipeline.js`, en sous-processus)
1. **Parsing du HAR** : lecture de toutes les réponses HTTP au format JSON (ou JSON embarqué dans un `<script id="__NEXT_DATA__">` d'une page HTML).
2. **Recherche récursive** (parcours itératif type DFS avec une pile, limité à 500 000 nœuds visités) de tout objet "ressemblant à une annonce" (présence d'un identifiant, d'un titre, d'un prix ou d'une URL).
3. **Normalisation** de chaque annonce brute vers un modèle de données unifié (voir section suivante).
4. **Fusion des doublons** par identifiant d'annonce.
5. **Écriture atomique** des résultats intermédiaires (`annonces.json`, `annonces.txt`, `annonces.csv` si activé) — écriture dans un fichier temporaire puis renommage, pour éviter la corruption en cas de crash.
6. **Enrichissement des descriptions** (`DescriptionEnricher`) : les résultats de recherche Leboncoin ne contiennent pas toujours la description complète. Le pipeline :
   - relance un navigateur Chromium (avec la session globale, images/CSS bloquées pour la vitesse) ;
   - envoie des requêtes `fetch()` **directement depuis la page** (pour hériter des cookies du navigateur) vers chaque URL d'annonce, **par batchs de 10 en parallèle** (`Promise.all`) pour aller vite ;
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

D'autres éléments transverses : bouton **widget flottant**, modale de **paramètres globaux** (voir ci-dessous).

### ⚙️ Modale Paramètres

Accessible via le bouton **⚙️ Paramètres** dans le header. Centralise tous les réglages utilisateur :

**🎨 Apparence**
- **Thème** : 13 thèmes (Sombre, Clair, OLED, Violet Doux, Vert Émeraude, Sunset, Carbon, Rose, Amber, Mint, Slate, Crimson, Nordic). Aperçu en temps réel à la sélection.

**🚀 Scraping**
- **Vitesse de scraping** : 3 presets pour l'enrichissement des descriptions :
  - ⚡ **Rapide** — 10 fetchs parallèles (`Promise.all`), délais courts (0,5-1s). Le plus rapide, mais risque de 403 plus élevé.
  - ⚖️ **Équilibré** — 5 fetchs parallèles, délais modérés (1-2s). Bon compromis vitesse/risque.
  - 🛡️ **Prudent** — séquentiel (1 fetch à la fois), délais humains (1,5-3s + 0,8-1,8s entre chaque). Anti-blocage maximal.
- **Délai entre les pages de recherche** (ms) : contrôle la vitesse de navigation entre les pages de résultats Leboncoin (défaut 1000ms).
- **Mode de capture** : invisible (headless) ou visible. En headless, le navigateur s'affiche automatiquement en cas de CAPTCHA.

**🧠 Analyse IA Locale** (nouveau)
- **Analyses simultanées** (parallélisme IA) : nombre d'annonces analysées en parallèle par l'IA locale (Ollama). Plus élevé = plus rapide, mais demande plus de RAM/VRAM. Recommandé : 3-5 pour CPU, 5-10 pour GPU. Défaut : 5.

**🧹 Maintenance**
- **Nettoyage auto des fichiers .har** (jours) : les fichiers .har plus anciens que ce nombre sont supprimés au démarrage (défaut 7).

Tous les paramètres sont sauvegardés dans `src/main/config/user-settings.json` et persistés entre les sessions. Le bouton **↺ Réinitialiser** remet tout aux valeurs par défaut.

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
| `toggleWidget()` | `widget:toggle` (send) | Affiche/masque le widget flottant always-on-top |
| `sendWidgetProgress(data)` / `sendWidgetStatus(data)` | `widget:progress` / `widget:status` (send) | Transmet la progression/statut au widget flottant |

> Le contrat IPC complet (17 canaux preload ↔ main) est vérifié automatiquement par la suite de tests de régression.

---

## 🛡️ Anti-blocage & gestion de session

L'application intègre plusieurs mécanismes pour limiter les risques de blocage par Leboncoin :

- **Session globale persistante** (`global-session.json`, stockée dans `output/` en dev, `Documents/Leboncoin Scraper Pro/` en version packagée) : les cookies validés (notamment après résolution d'un captcha) sont réutilisés pour tous les jobs suivants.
- **Sauvegarde de session intelligente** : la session globale est sauvegardée dès la **1ère page réussie** (HTTP < 400) pendant la capture, et **jamais écrasée ensuite** — les pages suivantes pouvant retourner 403 (anti-bot), leurs cookies ne corrompent pas la session propre.
- **Détection de blocage double** : un blocage est détecté soit par **marqueurs textuels** (`captcha`, `robot`, `restreint`, `vitesse surhumaine`, `captcha-delivery`) dans le titre/texte de la page, soit par **code HTTP d'erreur** (≥ 400, typiquement 403/429). Un 403 "silencieux" (sans page CAPTCHA) est ainsi correctement détecté.
- **Bascule en navigateur visible** : si un blocage est détecté lors du pré-check, une fenêtre Chromium **visible** s'ouvre pour permettre à l'utilisateur de résoudre manuellement (CAPTCHA) ou d'attendre que le blocage IP se lève. Le navigateur recharge la page toutes les 2 secondes pour vérifier si le blocage est levé.
- **Arrêt préventif de la capture** : si une page retourne un 403 pendant la capture, la boucle s'arrête **immédiatement** au lieu de gaspiller des requêtes sur les pages suivantes.
- **Masquage de l'empreinte "webdriver"** (`navigator.webdriver = undefined`) pour réduire la détection d'automatisation.
- **User-Agent réaliste** (Chrome Windows) et **locale `fr-FR`** fixés sur tous les contextes navigateur.
- **Enrichissement parallèle rapide** : les descriptions d'annonces sont fetchées **par batchs de 10 en parallèle** (`Promise.all`) avec une courte pause inter-batch (0,5-1s) pour limiter — sans éliminer — le risque de blocage.
- **Délais aléatoires** (jitter) entre les pages de recherche (0,8-1,5s) et entre les batches d'enrichissement (0,5-1s).
- **Arrêt préventif automatique** après 3 réponses HTTP 403/429 consécutives lors de l'enrichissement, pour éviter un bannissement IP prolongé — les données déjà collectées sont sauvegardées.
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

## 🧪 Tests de non-régression

Le projet inclut une suite de tests dans `test/regression.test.js` (script Node.js autonome, sans framework externe) couvrant **109 assertions** réparties en 5 sections :

1. **`utils/diagnostics.js`** (~26 tests) : helpers de log (`redact`, `formatBytes`, `summarizeAds`, `countBy`, `describeError`...).
2. **Modules principaux** (~14 tests) : exports et logique de `MarketAnalyzer`, `GlobalAnalyzer`, `JobSchedulerManager`, `DealFinder`, `StorageCleaner`, `FileManager`, `Notifier`, `settings`, `RISK_KEYWORDS`.
3. **Pipeline via `fork`** (~6 tests) : crée un faux HAR, lance le vrai pipeline en sous-processus, vérifie l'extraction (exit code 0, annonces extraites, normalisation `shipping`/`city`/`isPro`).
4. **Corrections PR #3** (~16 tests) : vérifie par lecture du code source que les fixes précédents sont présents (`mapInstance`, `escapeHtml`, `openExternal`, scheduler trigger, etc.).
5. **Architecture restructurée** (~47 tests) : vérifie la structure en couches (fichiers au bon endroit, anciens dossiers supprimés, `Notifier`/`settings`/`RISK_KEYWORDS` extraits, contrat IPC 17 canaux, widget flottant implémenté).

### Exécuter les tests

```bash
node test/regression.test.js
```

Résultat attendu : `=== RÉSULTAT : 109 réussis, 0 échoués ===`

> Le test installe des **stubs** pour `electron`, `playwright` et `exceljs` (lignes 13-29) afin de pouvoir `require()` les modules en Node pur, sans lancer Electron ni Chromium.

---

## ⚠️ Limitations connues

- Le scraping de Leboncoin repose sur la structure actuelle de leurs pages/API (`__NEXT_DATA__`, endpoints de recherche) : toute évolution significative du site peut nécessiter une adaptation du parsing (`leboncoin-pipeline.js`).
- La résolution de captcha reste **manuelle** (l'app ne la contourne pas automatiquement, elle ouvre une fenêtre visible et attend l'intervention humaine).
- L'analyse IA (marché, scoring, résumé) dépend de la qualité du modèle utilisé (un modèle local léger comme `llama3` peut être moins précis qu'un modèle cloud).
- L'enrichissement des descriptions est **parallèle** (10 requêtes simultanées par batch) pour la vitesse : si tu te fais bloquer (403), l'app s'arrête automatiquement après 3 blocages consécutifs et sauvegarde ce qui a déjà été collecté.
- Un blocage IP déjà actif (suite à de trop nombreux lancements rapprochés) peut nécessiter d'attendre quelques heures ou d'utiliser un proxy.

---

## ⚖️ Avertissement légal

Cet outil interagit avec un site tiers (Leboncoin.fr) dont les [conditions générales d'utilisation](https://www.leboncoin.fr/) peuvent restreindre ou interdire le scraping automatisé. L'utilisation de cette application est sous l'entière responsabilité de l'utilisateur, qui doit s'assurer de respecter la législation applicable (notamment concernant la protection des données personnelles, le RGPD pour les données de vendeurs particuliers, et les CGU du site ciblé) avant tout usage, en particulier à des fins commerciales.
