# Guide Utilisateur — Leboncoin Scraper Pro

Ce guide vous accompagne pas à pas dans l'utilisation de **Leboncoin Scraper Pro**, l'outil de scraping desktop pour [Leboncoin.fr](https://www.leboncoin.fr).

---

## 1. Installation

### Version installée (recommandée)
1. Téléchargez le fichier `.exe` d'installation depuis la page de téléchargement.
2. Double-cliquez sur le `.exe` et suivez l'assistant :
   - Choisissez le dossier d'installation.
   - Un raccourci bureau et une entrée dans le menu démarrer sont créés automatiquement.
3. Lancez **Leboncoin Scraper Pro** depuis le raccourci.

> Aucun prérequis : vous n'avez pas besoin d'installer Node.js, npm ou quoi que ce soit d'autre. Le navigateur Chromium est embarqué dans l'installeur.

### Version portable
La version portable (`Leboncoin-Scraper-Pro-Portable-x.x.x.exe`) ne nécessite aucune installation :
1. Décompressez l'archive dans un dossier de votre choix.
2. Lancez l'exécutable.

### Emplacement des données
- **Version installée** : `Documents/Leboncoin Scraper Pro/`
- **Version portable / dev** : dossier `output/` à côté de l'exécutable.

---

## 2. Premier lancement

### Écran d'information légal
Au premier lancement, un écran d'information s'affiche. Il rappelle que :
- ce logiciel est un outil technique d'automatisation et d'analyse ;
- vous devez vérifier que votre utilisation est autorisée par le site concerné ;
- vous êtes responsable des données collectées, conservées et exportées ;
- le logiciel ne vous accorde aucune autorisation particulière concernant les sites ou données de tiers.

Lisez attentivement puis cliquez sur « Accepter ». Cet écran ne s'affichera plus (sauf réaffichage manuel depuis les paramètres ou l'aide).

### Vérification du navigateur Chromium
L'application vérifie automatiquement la présence du navigateur Chromium (nécessaire au scraping). Si celui-ci manque, un **bandeau rouge** s'affiche en haut de la fenêtre avec la marche à suivre. En version installée, Chromium est embarqué et ce bandeau ne devrait pas apparaître.

---

## 3. Lancer un scraping

### Étapes
1. Ouvrez l'onglet **Scraper** (icône 🚀 dans la sidebar).
2. Collez l'**URL** d'une recherche Leboncoin dans le champ prévu.
   - Exemple : `https://www.leboncoin.fr/recherche?text=pc%20portable&category=15`
3. Indiquez le **nombre de pages** à scraper (1 à 100).
4. Choisissez un **profil de données** :
   - **Défaut** — champs essentiels (scraping rapide).
   - **Maximum** — toutes les données disponibles.
   - **Personnalisé** — sélection granulaire des champs.
5. (Optionnel) Ajustez les **options** :
   - **Vitesse** : Moyen / Rapide / Ultra-rapide.
   - **Mode de capture** : invisible (headless) ou visible.
   - **Ignorer les descriptions** : pour accélérer le scraping.
   - **Proxy** : si vous utilisez un proxy HTTP.
6. Cliquez sur **« Lancer le scraping »**.

### Progression
- La progression s'affiche en temps réel dans l'onglet Scraper.
- Un **widget flottant** (always-on-top) peut être ouvert pour suivre la progression sans garder l'app au premier plan.
- Les **logs** en direct sont visibles dans l'onglet Logs.

### Presets
Vous pouvez enregistrer une configuration (URL + pages + options) comme **preset** pour la réutiliser en un clic.

---

## 4. Résoudre un CAPTCHA

### Quand un CAPTCHA apparaît
Si Leboncoin détecte une activité robotique, l'application ouvre automatiquement une **fenêtre visible** affichant le captcha (Arkose, FunCaptcha, Cloudflare, etc.).

### Comment le résoudre
1. Résolvez le captcha **manuellement** dans la fenêtre qui s'est ouverte (cliquez sur les images, recopiez le texte, etc.).
2. **Ne fermez pas la fenêtre** et **ne cliquez sur rien d'autre**.
3. L'application détecte automatiquement la résolution :
   - Polling du contenu de la page toutes les 2 secondes.
   - Confirmation anti-faux-positif (re-vérification après 2s).
4. La fenêtre se ferme **toute seule** et le scraping reprend automatiquement.

> Vous n'avez aucune action supplémentaire à effectuer : résolvez le captcha et attendez.

### Session persistante
Une fois le captcha résolu, la session est sauvegardée dans `global-session.json`. Les prochains jobs réutiliseront cette session validée, ce qui évite de repasser un captcha à chaque lancement.

---

## 5. Consulter les annonces

### Onglet Explorateur
Après un scraping, ouvrez l'onglet **Explorateur** (icône 🔍 dans la sidebar) pour consulter les annonces.

### Filtres
- **Mot-clé** : recherche dans le titre et la description.
- **Prix min / max** : fourchette de prix.
- **Type de remise** : toutes / livraison / main propre / livraison + main propre.
- **Type vendeur** : tous / pro / particulier.
- **Note vendeur min** : 0 à 5.
- **Likes min** : nombre minimum de likes.
- **Catégorie** : peuplée dynamiquement depuis les annonces.
- **Ville** : recherche par sous-chaîne.

### Tri
- Prix croissant / décroissant
- Date de publication (récentes d'abord)
- Date de scraping
- Note vendeur décroissante
- Likes décroissants

### Vues
- **Vue tableau** : lignes compactes (titre, prix, ville, vendeur, date).
- **Vue grille** : cartes avec photo, titre, prix, ville.

### Fiche détaillée
Cliquez sur une annonce pour ouvrir la fiche détaillée :
- Photos (carrousel).
- Description complète.
- Informations vendeur (nom, type, note, avis, profil, ancienneté).
- Dates (publication, modification, scraping).
- Type de remise (`deliveryType`).
- Likes, état déclaré, nombre de photos.

---

## 6. Statistiques

### Onglet Statistiques
Ouvrez l'onglet **Stats** (icône 📊 dans la sidebar) pour visualiser les statistiques du job courant.

### Cartes
- **Total** d'annonces
- **Prix moyen / min / max**
- **Livraison** (nombre d'annonces avec livraison)
- **Main propre** (nombre d'annonces avec remise en main propre)
- **Pro / Particulier** (répartition par type de vendeur)

### Graphiques
- **Distribution des prix** (histogramme)
- **Vendeurs** (pro vs particulier)
- **Top 10 Villes** (barres)
- **Modes de transaction** (camembert — basé sur `deliveryType`)

### Carte interactive
- **Carte Leaflet** avec marqueurs pour chaque annonce géolocalisée.
- Filtre « Remise en main propre uniquement ».
- Géocodage via l'API Gouv France (cache LocalStorage, timeout 10s).
- Déduplication des annonces par id.

---

## 7. Historique

### Onglet Historique
Ouvrez l'onglet **Historique** (icône 📁 dans la sidebar) pour consulter tous les jobs passés.

### Actions disponibles
- **Ouvrir le dossier** : ouvre le dossier du job dans l'explorateur de fichiers.
- **Ouvrir un fichier** : ouvre directement le fichier JSON ou TXT.
- **Supprimer** : supprime le job et tout son contenu (annonces, exports, HAR, métadonnées).

### Nettoyage automatique
Dans les **Paramètres**, vous pouvez activer :
- le nettoyage automatique des fichiers `.har` après X jours (défaut : 7) ;
- la suppression automatique des jobs anciens (optionnel).

---

## 8. Paramètres

Ouvrez les **Paramètres** (icône ⚙️ dans l'en-tête) pour configurer l'application.

### Thème
13 thèmes disponibles (aperçu temps réel) : Dark, Light, OLED, Violet, Green, Sunset, Carbon, Rose, Amber, Mint, Slate, Crimson, Nordic.

### Vitesse de scraping
- **Moyen** : 10 parallèles, 0,5-1s entre les requêtes.
- **Rapide** : 15 parallèles, 0,2-0,6s.
- **Ultra-rapide** : 25 parallèles, 0,05-0,3s.

### Autres réglages
- **Délai entre les pages** (ms, défaut 1000).
- **Mode de capture** : invisible (headless) ou visible.
- **Données vendeur** : exclure les champs vendeur de tous les exports et de l'interface.
- **Nettoyage auto des .har** (jours, défaut 7).
- **Suppression auto des jobs** (optionnel).
- **Rétention des logs** (jours, défaut 7).

Bouton **Réinitialiser** pour revenir aux valeurs par défaut.

---

## 9. Exports

### Formats disponibles
Deux formats d'export sont générés automatiquement à la fin de chaque job :

| Format | Fichier | Contenu | Usage |
|---|---|---|---|
| **JSON** | `annonces.json` | Données structurées + checksum SHA-256 | Reprise programmatique, intégration |
| **TXT** | `annonces.txt` | Texte lisible (blocs alignés par annonce) | Lecture humaine, partage |

> Les formats XLSX et CSV ne sont plus disponibles.

### Filtrage par profil
Le contenu des exports dépend du **profil** choisi au moment du scraping :
- **Profil Défaut** : 13 champs essentiels.
- **Profil Maximum** : toutes les données disponibles.
- **Profil Personnalisé** : uniquement les champs sélectionnés.

### Exclusion vendeur
Si l'option « Données vendeur » est désactivée dans les paramètres, les champs vendeur (nom, ID, type, note, avis, URL profil, ancienneté) sont **exclus** de tous les exports, quel que soit le profil.

### Où trouver les fichiers
- Onglet **Historique** → cliquez sur le bouton « Ouvrir le dossier » du job.
- Les fichiers sont dans `output/jobs/job-<timestamp>/results/`.
- `annonces.json` et `annonces.txt` sont dans le sous-dossier `results/`.
