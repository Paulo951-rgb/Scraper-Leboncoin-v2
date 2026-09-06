# Gestion des données — Transparence et minimisation

Ce document détaille les catégories de données traitées par **Leboncoin Scraper Pro**, leur finalité, leur persistance et les options de contrôle dont dispose l'utilisateur.

## Principes

1. **Collecte minimale** : le logiciel ne collecte que les données présentes dans les réponses réseau du site ciblé. Aucune donnée n'est inventée ou extrapolée lors du scraping.
2. **Transparence** : chaque catégorie de données est documentée ci-dessous avec sa finalité et sa traçabilité.
3. **Contrôle utilisateur** : l'utilisateur peut configurer quelles données sont conservées, exportées et affichées.

## Tableau des catégories de données

| Catégorie | Utilisation | Exportable | Désactivable | Stockage |
|-----------|-------------|------------|--------------|----------|
| Informations annonce (titre, prix, URL, localisation, dates, photos, description) | Analyse, export, statistiques | Oui (TXT, JSON, CSV, XLSX, Texte raccourci) | Oui (sélection personnalisée des champs) | Disque local (`output/jobs/`) |
| Prix | Analyse de marché, statistiques, filtres | Oui | Oui (peut être exclu du mode Personnalisé) | Disque local |
| Description | Analyse IA (texte), export TXT | Oui | Oui (case « Ignorer les descriptions » + sélection personnalisée) | Disque local |
| Données vendeur (nom, ID, type, note, avis, URL profil, ancienneté) | Identification, filtres, statistiques, export | Oui | Oui (paramètre « Données vendeur » dans les réglages) | Disque local |
| Données brutes HAR (capture réseau complète) | Diagnostic, reprise de scraping, intégrité | Non (fichier technique `.har`) | Oui (nettoyage automatique paramétrable) | Disque local, nettoyé après X jours |
| Analyses IA (produit identifié, résumé, verdict marché, valeur estimée, sources) | Aide à la décision, export | Oui (champs granulaires ou blocs complets) | Partiellement (sélection personnalisée) | Disque local (dans `annonces.json`) |
| Favoris et filtres utilisateur | Interface, rappel entre sessions | Non | Oui (effacement localStorage) | localStorage (navigateur intégré) |
| Clés API (moteur de recherche) | Accès à des services de recherche web | Non | Oui (suppression dans les paramètres) | Stockage chiffré OS (safeStorage) |

## Modes d'export et minimisation

### Mode Défaut
Toutes les informations disponibles sont exportées. Ce mode garantit une sauvegarde complète et intacte de chaque session.

### Mode Personnalisé
L'utilisateur sélectionne uniquement les champs qu'il souhaite conserver. Les champs non sélectionnés n'apparaissent dans aucun export (JSON, TXT, Texte raccourci, XLSX, CSV).

### Données vendeur
Un paramètre dédié permet d'exclure systématiquement les champs identifiés comme données vendeur de tous les exports, quelle que soit la sélection personnalisée. Cela concerne :
- Nom du vendeur
- ID du vendeur
- URL du profil vendeur
- Note du vendeur
- Nombre d'avis
- Ancienneté du vendeur

### Descriptions
L'utilisateur peut choisir d'ignorer les descriptions lors du scraping (case « Ignorer les descriptions » dans le formulaire de recherche). Cela accélère le traitement et réduit la quantité de texte conservé.

## Persistance et durée de vie

| Support | Données | Durée de vie |
|---------|---------|--------------|
| `output/jobs/job-<timestamp>/` | Annonces, exports, métadonnées | Jusqu'à suppression manuelle ou automatique (paramétrable) |
| `output/jobs/job-<timestamp>/capture.har` | Capture réseau brute | Nettoyage automatique paramétrable (défaut : 7 jours) |
| `user-settings.json` | Paramètres utilisateur | Persistante |
| `localStorage` | Favoris, filtres, préférences UI | Persistante (navigateur intégré) |
| `safeStorage` (OS) | Clés API chiffrées | Persistantes |

## Suppression des données

L'utilisateur peut supprimer individuellement chaque job depuis l'onglet Historique. La suppression entraîne l'effacement complet du dossier correspondant (annonces, exports, HAR, métadonnées).

Le nettoyage automatique des jobs anciens et des fichiers HAR peut être activé dans les paramètres.

## Aucune transmission externe

En mode de fonctionnement standard :
- L'analyse IA est effectuée localement par Ollama (100% local). Aucune donnée n'est transmise à un serveur distant pour l'analyse.
- Les exports sont générés et stockés localement.
- Aucune télémétrie, aucun tracking et aucun compte-rendu automatique n'est envoyé au développeur.

Les seules connexions réseau externes sont :
- vers le site ciblé pour la collecte ;
- vers le serveur Ollama local (127.0.0.1) ;
- vers l'API de géocodage du gouvernement français pour la carte (si activée) ;
- vers un moteur de recherche web si l'IA Marché est utilisée (DuckDuckGo ou Tavily, selon la configuration).

## Informations sensibles

Si vous collectez des données sensibles ou personnelles, appliquez les principes suivants :
- Ne conservez que ce qui est strictement nécessaire.
- Désactivez les données vendeur si elles ne sont pas utiles à votre analyse.
- Supprimez les jobs dès qu'ils ne sont plus nécessaires.
- Utilisez le chiffrement de disque si votre système l'autorise.
- Consultez un professionnel juridique si vous avez un doute sur la légalité de votre traitement.
