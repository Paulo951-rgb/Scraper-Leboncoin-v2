# FAQ — Leboncoin Scraper Pro

Questions fréquentes sur l'utilisation de **Leboncoin Scraper Pro**.

---

## Pourquoi un CAPTCHA apparaît ?

Leboncoin détecte les activités robotiques (navigation rapide, nombreuses requêtes) et affiche un CAPTCHA (Arkose, FunCaptcha, Cloudflare) pour vérifier qu'un humain est derrière l'écran. C'est une mesure de protection normale.

**Que faire** : résolvez le CAPTCHA manuellement dans la fenêtre qui s'ouvre. L'application détecte automatiquement la résolution (polling du contenu + confirmation anti-faux-positif) et reprend le scraping toute seule. Vous n'avez rien d'autre à faire.

---

## Que faire si le scraping s'arrête ?

Plusieurs causes possibles :

1. **CAPTCHA non résolu** : si une fenêtre captcha est restée ouverte trop longtemps (timeout 10 min), le scraping s'arrête. Relancez-le.
2. **Erreurs 403/429** : Leboncoin bloque temporairement votre IP. Patientez quelques minutes, réduisez la vitesse ou utilisez un proxy.
3. **3 blocages consécutifs** : après 3 blocages 403/429 pendant l'enrichissement des descriptions, le scraping s'arrête automatiquement et **sauvegarde** les données déjà collectées. Consultez l'onglet Historique.
4. **Navigateur Chromium manquant** : un bandeau rouge s'affiche. Réinstallez l'application ou lancez `npx playwright install chromium` (en dev).
5. **Connexion internet** : vérifiez votre connexion (badge de connectivité dans l'en-tête).

---

## Pourquoi certaines données sont nulles ?

Tout champ non trouvé dans la réponse de Leboncoin est `null` (jamais `0`, jamais `''`, jamais une valeur inventée). C'est normal si :
- le vendeur n'a pas de note (compte récent) ;
- la date de modification est absente (annonce non modifiée) ;
- le nombre d'avis n'est pas exposé ;
- l'état déclaré n'est pas renseigné par le vendeur.

L'application ne **devine jamais** une donnée absente. C'est un principe de conception : seules les données réellement présentes sont collectées.

---

## Pourquoi une annonce n'a pas de vendeur ?

Certaines annonces n'exposent pas d'objet `owner` (vendeur) dans leur structure. Cela peut arriver si :
- l'annonce a été supprimée entre la capture de la liste et l'enrichissement ;
- Leboncoin masque certaines informations vendeur pour des comptes récents ;
- la structure de l'annonce a changé.

Dans ce cas, tous les champs vendeur (`vendeurNom`, `vendeurType`, `vendeurId`, `vendeurNote`, etc.) sont `null`.

---

## Pourquoi une annonce peut disparaître ?

Une annonce présente dans les résultats de recherche peut disparaître lors de l'enrichissement si :
- le vendeur l'a supprimée entre-temps ;
- Leboncoin l'a modérée (retirée pour non-respect des règles) ;
- l'annonce a expiré.

L'application gère ces cas avec les codes d'erreur `AD_DELETED` et `AD_MODIFIED` (voir `errorCodes.js`). Les données déjà collectées sont conservées.

---

## Où sont enregistrées les données ?

- **Version installée** : `Documents/Leboncoin Scraper Pro/`
  - `jobs/job-<timestamp>/results/annonces.json` — données structurées.
  - `jobs/job-<timestamp>/results/annonces.txt` — texte lisible.
  - `jobs/job-<timestamp>/capture.har` — capture réseau brute.
  - `global-session.json` — session Leboncoin persistante.
  - `user-settings.json` — paramètres.
  - `logs/scraper-YYYY-MM-DD.log` — logs quotidiens.
- **Version portable / dev** : dossier `output/` à côté de l'exécutable.

Toutes les données restent **100% locales** sur votre ordinateur. Aucune donnée n'est envoyée vers un service externe.

---

## Comment créer un build (.exe) ?

### Prérequis
- Node.js + npm installés.
- Dépendances installées (`npm install`).
- Chromium Playwright téléchargé (`npx playwright install chromium`).

### Générer l'installeur
```bash
npm run dist
```

Produit dans `dist/` :
- `Leboncoin Scraper Pro Setup x.x.x.exe` — installeur NSIS.
- `Leboncoin-Scraper-Pro-Portable-x.x.x.exe` — version portable.

### Packaging local (test)
```bash
npm run pack
```

---

## Comment lancer en développement ?

```bash
# 1. Installer les dépendances
npm install
npx playwright install chromium

# 2. Lancer l'application
npm start

# 3. Lancer les tests
npm test
```

`npm start` lance Electron avec 8 Go de mémoire allouée à V8 (`--max-old-space-size=8192`) pour gérer les gros fichiers `.har`.

---

## Que faire en cas de 403/429 ?

Les erreurs **403** (accès refusé) et **429** (trop de requêtes) indiquent que Leboncoin bloque temporairement votre IP.

**Solutions** :
1. **Patienter** : le blocage est temporaire (quelques minutes à quelques heures).
2. **Réduire la vitesse** : passez en mode « Moyen » (10 parallèles, 0,5-1s).
3. **Augmenter le délai entre les pages** : dans les Paramètres (défaut 1000 ms, essayez 2000-3000 ms).
4. **Utiliser un proxy** : renseignez un proxy HTTP dans le champ « Proxy » du formulaire de scraping.
5. **Après 3 blocages consécutifs** : l'enrichissement s'arrête automatiquement et sauvegarde les données collectées. Consultez l'onglet Historique.

---

## Quelles sont les limitations ?

- Le scraping repose sur la structure actuelle de Leboncoin (`__NEXT_DATA__`, endpoints de recherche) : toute évolution du site peut nécessiter une adaptation du parsing.
- La résolution de captcha est **manuelle** (l'app ouvre une fenêtre visible), mais la détection de résolution est **automatique**.
- L'enrichissement des descriptions est parallèle (10 à 25 simultanées selon la vitesse) : en cas de 403, arrêt auto après 3 blocages.
- Un blocage IP déjà actif peut nécessiter d'attendre ou d'utiliser un proxy.
- Les données sont **100% locales** : aucune analyse par IA, aucune estimation de valeur marché, aucun résumé automatique. L'application scrape, structure et exporte — c'est tout.

---

## Quels formats d'export sont disponibles ?

Deux formats d'export sont disponibles :

| Format | Fichier | Description |
|---|---|---|
| **JSON** | `annonces.json` | Données structurées + checksum SHA-256 pour l'intégrité |
| **TXT** | `annonces.txt` | Texte lisible, blocs alignés par annonce |

> **Note** : Les formats XLSX (Excel) et CSV ne sont **plus disponibles**. Seuls JSON et TXT sont générés.

Le contenu des exports dépend du **profil** choisi :
- **Défaut** : 13 champs essentiels.
- **Maximum** : toutes les données disponibles.
- **Personnalisé** : uniquement les champs sélectionnés.

---

## Qu'est-ce que le `deliveryType` ?

Le champ `deliveryType` est un champ unifié qui décrit le mode de remise d'une annonce. Il remplace les anciens champs séparés `livraison` et `mainPropre` par une seule valeur :

| Valeur | Signification |
|---|---|
| `les_deux` | Livraison **et** remise en main propre |
| `livraison` | Livraison uniquement |
| `main_propre` | Remise en main propre uniquement |
| `aucun` | Ni livraison ni main propre |
| `inconnu` | Indéterminé (données indisponibles) |

Cette valeur est extraite à partir des attributs structurés de l'annonce et de l'analyse de la description (mentions « remise en main propre », « retrait sur place », « pas d'envoi », etc.).

---

## Quelle est la différence entre les profils Défaut et Maximum ?

### Profil Défaut
- **13 champs essentiens** : id, title, url, prix, ville, codePostal, deliveryType, datePublication, dateScraping, vendeurNom, vendeurType, photosCount, description.
- Scraping **rapide et léger**.
- Idéal pour un aperçu rapide des annonces.

### Profil Maximum
- **Toutes les données disponibles** (~23 champs) : tous les champs du profil Défaut + vendeurId, vendeurNote, vendeurNbAvis, vendeurUrlProfil, vendeurAnciennete, likes, dateModification, etat, photosUrls.
- Scraping **complet**.
- Idéal pour une sauvegarde exhaustive.

### Profil Personnalisé
- **Choix de l'utilisateur** : sélection granulaire par catégorie (Identification, Prix, Localisation, Vendeur, Transaction, Dates, Statistiques, Produit, Photos, Description).
- Idéal pour ne collecter que ce qui vous intéresse.

Le profil se choisit dans l'onglet Scraper avant de lancer le scraping. La sélection Personnalisé est sauvegardée pour les sessions suivantes.
