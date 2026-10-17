# Problèmes connus — Vendra

*Mis à jour : 2026-10-10*

Cette liste ne contient que des problèmes **non résolus** au terme de l'audit de
stabilisation. Pour chaque entrée : impact, circonstances, prochaines étapes.

---

## KI-1 — Démarrage de l'exe Windows non testé sur Windows réel *(P2, environnement)*

- **Statut (mise à jour)** : le build Windows est désormais réalisé nativement
  par GitHub Actions sur un runner **Windows** (`windows-latest`), via
  `.github/workflows/build-windows.yml`. Cela supprime la cause de l'erreur
  `Error: spawn UNKNOWN` observée en build croisé Linux → Windows
  (`NsisTarget.computeScriptAndSignUninstaller` → exécution de l'installeur, très
  volumineux, pour extraire le désinstalleur, sous Wine). L'installeur et la
  version portable sont vérifiés par `tools/verify-dist.js` avant publication
  (installeur NSIS, `win-unpacked/` + `app.asar` + `ffmpeg.dll`, Chromium
  embarqué, en-tête PE, taille minimale).
- **Impact résiduel** : **le lancement effectif sous Windows** (exécution de
  l'installeur par un utilisateur final, démarrage de l'app, scraping réel,
  désinstallation) n'a pas pu être rejoué dans l'environnement d'écriture (Linux).
  Les contrôles automatisés portent sur la présence et la structure des fichiers,
  pas sur l'exécution.
- **Circonstances** : uniquement lors de la distribution.
- **Prochaines étapes** : télécharger l'artefact de la CI (ou la Release),
  exécuter l'installeur sur Windows 10/11 x64, lancer l'app, vérifier le
  démarrage hors ligne, un job de scraping complet, puis la désinstallation.

## KI-2 — Tests d'interface graphique : partiellement couverts *(P3, tests)*

- **Statut (mise à jour 2026-10-17)** : un harnais **E2E Electron réel** a été
  ajouté (`test/e2e.electron.test.js`, exécuté via `npm run test:e2e`). Il
  **lance réellement** l'application (main process + renderer) en mode headless
  (`--ozone-platform=headless`) et vérifie : démarrage sans écran blanc, présence
  des onglets, **navigation entre les onglets**, ouverture des modales
  (Paramètres/FAQ), absence de contrôle de vitesse modifiable, affichage en
  lecture seule de la politique, et l'absence de fuite Node dans le renderer
  (`require`/`process`/`fs`/`child_process`/`eval`, `nodeIntegration` désactivé,
  `contextIsolation` actif). Il est intégré au workflow CI (`checks`).
- **Impact résiduel** : les parcours **métier complets** (création d'un job avec
  capture réseau réelle, progression, annulation, export depuis l'UI) ne sont pas
  encore couverts de bout en bout car ils exigent un accès réseau à Leboncoin ou
  une injection de fixtures dans le processus principal. Les tests de pipeline
  (`[35]`/`[36]`/`[42]`/`[43]`) couvrent en revanche la chaîne
  HAR→normalisation→export sur fixtures.
- **Circonstances** : toute modification des modules `src/renderer/` ou de `main.js`.
- **Prochaines étapes** : étendre le harnais E2E à un job simulé (fixture HAR
  injectée) couvrant progression → arrêt → export, en environnement CI sans réseau.

## KI-3 — `urlSecurity` : couverture DNS incomplète sur le chemin navigateur *(P2, sécurité)*

- **Statut : partiellement résolu (phase 2).** `isSafeFetchDestination` (synchrone,
  fail-closed) est désormais **câblé** sur le chemin Playwright :
  - `HarCapturer.capture()` refuse une URL de recherche hors domaines Leboncoin
    ou visant une IP interdite (allowlist `LEBONCOIN_SOURCE_HOSTS`) ;
  - `_installNetworkGuard` intercepte toutes les sous-requêtes (`ctx.route('**/*')`)
    et bloque IP privées/locales et schémas exotiques ;
  - `validateRemoteUrl` est fail-closed si la résolution DNS est vide.
- **Limite résiduelle** : le filtre synchroné ne fait **pas** de résolution DNS
  (impossible dans le callback `route` sans blocage). Un hostname arbitraire
  résolvant vers une IP privée (DNS rebinding) n'est pas détecté sur les
  sous-ressources. Documenté dans le code.
- **Prochaines étapes** : envisager un proxy applicatif ou une résolution DNS
  asynchrone préalable si le risque rebinding devient pertinent.

## KI-4 — Repli de chiffrement des secrets à protection réduite *(P3, sécurité)*

- **Impact** : si le trousseau OS est indisponible, les secrets sont chiffrés
  avec une clé dérivée d'informations machine publiques. Cela évite le clair sur
  disque mais ne protège pas contre un accès au système de fichiers.
- **Circonstances** : systèmes sans `safeStorage` disponible.
- **Prochaines étapes** : exposer l'avertissement dans l'UI (via
  `SecretStore.isUsingOsKeychain()`) et, à terme, refuser le stockage plutôt que
  de dégrader silencieusement.

## KI-5 — Dépendances vulnérables non corrigeables sans majeur *(P3)*

- **Impact** : `npm audit` (mise à jour 2026-10-17) → **8 vulnérabilités
  modérées**, toutes dans la chaîne **devDependencies** `electron-builder`
  (`sprintf-js` ← `roarr` ← `global-agent` ← `@electron/get` ← `app-builder-lib`
  / `dmg-builder` / `electron-builder-squirrel-windows`). **Aucune vulnérabilité
  dans les dépendances de production** (`npm audit --omit=dev` → *found 0
  vulnerabilities*). Les outils de build ne sont **pas embarqués** dans le
  binaire final (l'installeur ne contient que `src/`, `node_modules/playwright*`
  et le Chromium).
- **Corrigé dans cette mission** : `playwright` porté à `^1.64.1` (dépendance
  **directe** de production, la plus critique), `electron` à `^44.9.0` et
  `electron-builder` à `^26.15.3` (build). La CVE « téléchargement sans
  vérification TLS » de Playwright est **hors** du chemin runtime.
- **Reste à faire** : les 8 avis modérés ne sont corrigeables que par une
  montée majeure de `electron-builder` (`npm audit fix --force` → 26.5.0, en
  réalité une régression de version ici). Impact limité au build ; à planifier
  avec une campagne de packaging Windows.
- **Prochaines étapes** : suivre les correctifs amont d'`@electron/get` ; ne PAS
  lancer `npm audit fix --force` sans revalider le packaging complet.

## KI-7 — ~~Icône de build manquante~~ *(RÉSOLU, packaging)*

- **Résolu** : `build/icon.ico` (multi-résolutions 16→256) et `build/icon.png`
  sont désormais présents et générables via `npm run icon`
  (`tools/generate-icon.py`, Pillow). La cible portable et l'installeur NSIS
  utilisent bien l'icône dédiée (vérifié dans l'exe : groupe d'icônes présent).
- Conservé ici pour mémoire : ne pas réintroduire un `icon` pointant vers un
  fichier absent.

## KI-6 — Blocage anti-bot Leboncoin (comportement normal, documenté) *(P3)*

- **Impact** : en cas de 403/CAPTCHA, le scraping s'arrête de façon préventive
  (`stoppedEarly`) et sauvegarde les données déjà acquises.
- **Circonstances** : surcharge, IP réputée mauvaise, captcha.
- **Prochaines étapes** : aucune correction agressive (respect des CGU) ; le
  comportement est volontaire.
