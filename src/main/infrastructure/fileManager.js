'use strict';

const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

class FileManager {
  static openFolder(folderPath) {
    // Crée le dossier s'il n'existe pas encore (au premier lancement, les
    // dossiers output/jobs n'existent pas → openPath échoue silencieusement
    // et le bouton "Ouvrir les jobs" paraissait ne rien faire).
    try {
      fs.mkdirSync(folderPath, { recursive: true });
    } catch (e) {
      throw new Error(`Impossible de créer le dossier "${folderPath}" : ${e.message}`);
    }
    shell.openPath(folderPath);
  }

  static openFile(filePath) {
    if (fs.existsSync(filePath)) {
      shell.openPath(filePath);
    } else {
      throw new Error(`Le fichier "${filePath}" n'existe pas encore.`);
    }
  }
}

module.exports = { FileManager };