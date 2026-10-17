#!/usr/bin/env node
'use strict';

/**
 * Prépare le Chromium Playwright destiné au packaging Electron.
 *
 * Objectif : garantir que l'application packagée embarque le Chromium de la
 * BONNE plateforme, et pas celui de la machine de build. Sur un poste Windows,
 * `playwright install --with-deps chromium` suffit ; mais une CI Linux qui
 * produit un installeur Windows doit télécharger explicitement le Chromium
 * Windows (build `win64`), sinon l'exécutable embarqué ne démarre pas.
 *
 * Le script :
 *   1. détermine la plateforme cible (--platform=win|mac|linux, défaut = hôte) ;
 *   2. lit la révision Chromium dans node_modules/playwright-core/browsers.json ;
 *   3. télécharge et extrait l'archive correspondante dans
 *      node_modules/playwright-core/.local-browsers/chromium-<rev>/ (chemin que
 *      electron-builder copie vers resources/browsers/ via extraResources) ;
 *   4. marque l'installation comme complète (fichier INSTALLATION_COMPLETE).
 *
 * Le téléchargement est idempotent : si le dossier cible existe déjà avec le
 * bon exécutable, l'étape est ignorée.
 *
 * Utilisation :
 *   node tools/prepare-browsers.js                 # plateforme hôte
 *   node tools/prepare-browsers.js --platform=win  # Chromium Windows (build win sur Linux)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PW_CORE = path.join(ROOT, 'node_modules', 'playwright-core');
const LOCAL_BROWSERS = path.join(PW_CORE, '.local-browsers');

// ── Schémas de téléchargement Chromium ───────────────────────────────────────
// Playwright a changé de distribution : les anciennes versions publiaient un
// build « chromium » (archive chromium-<platform>.zip, extraite dans chrome-win
// / chrome-linux / chrome-mac) ; les versions récentes (≥ 1.49) publient un
// build « Chrome for Testing » (archive chrome-<platform>.zip, extraite dans
// chrome-win64 / chrome-linux64 / chrome-mac-<arch>). On supporte les DEUX :
// le schéma effectif est déterminé par la première archive téléchargeable.
const CDN_PRIMARY = 'https://cdn.playwright.dev/builds';
const CDN_FALLBACK = 'https://playwright.azureedge.net/builds';

function getArgPlatform() {
  const arg = process.argv.find((a) => a.startsWith('--platform='));
  if (arg) return arg.split('=')[1];
  // Hôte → cible Playwright
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// ── Ancien schéma « chromium » ───────────────────────────────────────────────
// Archive : chromium-win64.zip / chromium-mac.zip / chromium-linux.zip
// Extraction : chrome-win / chrome-mac / chrome-linux
function archiveName(platform, arch) {
  if (platform === 'win') return arch === 'arm64' ? 'chromium-win-arm64.zip' : 'chromium-win64.zip';
  if (platform === 'mac') return arch === 'arm64' ? 'chromium-mac-arm64.zip' : 'chromium-mac.zip';
  return 'chromium-linux.zip';
}

function extractedDir(platform) {
  if (platform === 'win') return 'chrome-win';
  if (platform === 'mac') return 'chrome-mac';
  return 'chrome-linux';
}

// ── Nouveau schéma « Chrome for Testing » (Playwright ≥ 1.49) ────────────────
// Archive : chrome-win64.zip / chrome-mac-arm64.zip / chrome-linux64.zip
// Extraction : chrome-win64 / chrome-mac-<arch> / chrome-linux64
function cftArchiveName(platform, arch) {
  if (platform === 'win') return arch === 'arm64' ? 'chrome-win-arm64.zip' : 'chrome-win64.zip';
  if (platform === 'mac') return arch === 'arm64' ? 'chrome-mac-arm64.zip' : 'chrome-mac-x64.zip';
  return arch === 'arm64' ? 'chrome-linux-arm64.zip' : 'chrome-linux64.zip';
}

function cftExtractedDir(platform, arch) {
  if (platform === 'win') return arch === 'arm64' ? 'chrome-win-arm64' : 'chrome-win64';
  if (platform === 'mac') return arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64';
  return arch === 'arm64' ? 'chrome-linux-arm64' : 'chrome-linux64';
}

// Chemin de l'exécutable dans le dossier extrait, selon le schéma.
function exeNameIn(platform, scheme) {
  if (scheme === 'cft') {
    if (platform === 'win') return 'chrome.exe';
    if (platform === 'mac') return path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    return 'chrome';
  }
  if (platform === 'win') return 'chrome.exe';
  if (platform === 'mac') return 'Chromium.app';
  return 'chrome';
}

function config() {
  const platform = getArgPlatform();
  const arch = process.env.npm_config_arch || (platform === 'win' ? 'x64' : process.arch);
  const browsersJson = JSON.parse(fs.readFileSync(path.join(PW_CORE, 'browsers.json'), 'utf8'));
  const chromium = browsersJson.browsers.find((b) => b.name === 'chromium');
  if (!chromium) throw new Error('Révision Chromium introuvable dans browsers.json');
  return { platform, arch, revision: chromium.revision, version: chromium.browserVersion };
}

/**
 * Construit la liste ordonnée des schémas candidats (URL + dossier extrait +
 * exécutable). Le schéma « cft » (Chrome for Testing) est essayé en premier car
 * il correspond aux versions récentes de Playwright ; l'ancien schéma sert de
 * repli. Exporté pour les tests.
 */
function downloadSchemes(platform, arch, revision, version) {
  const cftDir = cftExtractedDir(platform, arch);
  const legacyDir = extractedDir(platform);
  const schemes = [];
  if (version) {
    const cftArchive = cftArchiveName(platform, arch);
    const cftPlatform = platform === 'win' ? (arch === 'arm64' ? 'win-arm64' : 'win64')
      : platform === 'mac' ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
      : (arch === 'arm64' ? 'linux-arm64' : 'linux64');
    schemes.push({
      name: 'cft',
      dir: cftDir,
      exe: exeNameIn(platform, 'cft'),
      urls: [
        `${CDN_PRIMARY}/cft/${version}/${cftPlatform}/${cftArchive}`,
        `${CDN_FALLBACK}/cft/${version}/${cftPlatform}/${cftArchive}`,
      ],
    });
  }
  schemes.push({
    name: 'chromium',
    dir: legacyDir,
    exe: exeNameIn(platform, 'chromium'),
    urls: [
      `${CDN_PRIMARY}/chromium/${revision}/${archiveName(platform, arch)}`,
      `${CDN_FALLBACK}/chromium/${revision}/${archiveName(platform, arch)}`,
    ],
  });
  return schemes;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function unzip(zipPath, destDir) {
  // Dépendance déjà présente (transitive de playwright) : pas d'appel système.
  const extract = require('extract-zip');
  return extract(zipPath, { dir: path.resolve(destDir) });
}

async function main() {
  const { platform, arch, revision, version } = config();
  const targetDir = path.join(LOCAL_BROWSERS, `chromium-${revision}`);
  const marker = path.join(targetDir, 'INSTALLATION_COMPLETE');
  const schemes = downloadSchemes(platform, arch, revision, version);

  console.log(`[prepare-browsers] Cible : ${platform}-${arch}, Chromium ${version} (rev ${revision})`);

  // Déjà installé ? On teste l'exécutable de CHAQUE schéma possible.
  for (const s of schemes) {
    const exePath = path.join(targetDir, s.dir, s.exe);
    if (fs.existsSync(exePath)) {
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
      console.log(`[prepare-browsers] Déjà présent (${s.name}) → ${targetDir} (ignoré).`);
      return;
    }
  }

  const tmpZip = path.join(os.tmpdir(), `pw-${platform}-chromium-${revision}.zip`);
  let chosen = null;
  for (const s of schemes) {
    for (const url of s.urls) {
      try {
        console.log(`[prepare-browsers] Téléchargement (${s.name}) : ${url}`);
        await download(url, tmpZip);
        chosen = s;
        break;
      } catch (err) {
        console.warn(`[prepare-browsers] Échec (${url}) : ${err.message}`);
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    throw new Error(`Téléchargement du Chromium ${platform} impossible (aucun schéma disponible sur le CDN).`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`[prepare-browsers] Extraction (${chosen.name}) vers ${targetDir}…`);
  await unzip(tmpZip, targetDir);
  const exePath = path.join(targetDir, chosen.dir, chosen.exe);
  if (!fs.existsSync(exePath)) {
    throw new Error(`Archive extraite mais exécutable introuvable : ${exePath}`);
  }
  fs.writeFileSync(marker, '');
  fs.unlinkSync(tmpZip);
  console.log(`[prepare-browsers] Terminé : ${chosen.dir}/${chosen.exe} embarqué pour ${platform}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[prepare-browsers] Échec :', err.message);
    process.exit(1);
  });
}

// Exports pour les tests unitaires (nom d'archive/sous-dossier selon plateforme).
module.exports = { archiveName, extractedDir, cftArchiveName, cftExtractedDir, downloadSchemes, getArgPlatform };
