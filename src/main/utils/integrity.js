'use strict';

/**
 * Validation d'intégrité des fichiers JSON via checksum SHA-256.
 * Permet de détecter la corruption (écriture interrompue, disque défaillant…).
 *
 * Usage :
 *   writeWithChecksum(filePath, jsonData)  → écrit .json + .sha256
 *   readWithChecksum(filePath)             → vérifie le .sha256 avant de parser
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function computeHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function checksumPath(filePath) {
  return `${filePath}.sha256`;
}

/**
 * Écrit un fichier JSON + son fichier de checksum associé (atomique).
 * @param {string} filePath  chemin du .json
 * @param {*} data           donnée à sérialiser
 * @param {Function} [replacer]
 * @param {number} [space]
 */
function writeWithChecksum(filePath, data, replacer, space) {
  const content = JSON.stringify(data, replacer, space);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Écriture atomique du JSON
  const tmpJson = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpJson, content, 'utf8');
  fs.renameSync(tmpJson, filePath);

  // Écriture du checksum
  const hash = computeHash(content);
  const tmpSha = `${checksumPath(filePath)}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpSha, hash, 'utf8');
  fs.renameSync(tmpSha, checksumPath(filePath));
}

/**
 * Lit et valide un fichier JSON via son checksum.
 * @param {string} filePath  chemin du .json
 * @returns {{ data: *, valid: boolean, reason: string|null }}
 *   - valid=true  : checksum OK (ou absent, auquel cas on ne valide pas mais on parse)
 *   - valid=false : checksum présent mais ne correspond pas → corruption
 */
function readWithChecksum(filePath) {
  if (!fs.existsSync(filePath)) {
    return { data: null, valid: false, reason: 'Fichier introuvable.' };
  }

  const content = fs.readFileSync(filePath, 'utf8');

  // Si un fichier .sha256 existe, on valide
  const shaPath = checksumPath(filePath);
  if (fs.existsSync(shaPath)) {
    const expected = fs.readFileSync(shaPath, 'utf8').trim();
    const actual = computeHash(content);
    if (expected !== actual) {
      return { data: null, valid: false, reason: `Checksum invalide (attendu ${expected.slice(0, 12)}…, obtenu ${actual.slice(0, 12)}…).` };
    }
  }

  try {
    return { data: JSON.parse(content), valid: true, reason: null };
  } catch (err) {
    return { data: null, valid: false, reason: `JSON invalide : ${err.message}` };
  }
}

/**
 * Vérifie uniquement l'intégrité (sans parser le JSON).
 * @returns {boolean} true si checksum OK ou absent, false si corrompu.
 */
function verify(filePath) {
  const shaPath = checksumPath(filePath);
  if (!fs.existsSync(shaPath)) return true; // pas de checksum = pas de validation possible
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const expected = fs.readFileSync(shaPath, 'utf8').trim();
  return computeHash(content) === expected;
}

module.exports = { writeWithChecksum, readWithChecksum, verify, computeHash, checksumPath };
