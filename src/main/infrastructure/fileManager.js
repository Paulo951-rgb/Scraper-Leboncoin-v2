'use strict';

const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

class FileManager {
  static async openFolder(folderPath) {
    // Crée le dossier s'il n'existe pas encore (au premier lancement, les
    // dossiers output/jobs n'existent pas → openPath échoue silencieusement
    // et le bouton "Ouvrir les jobs" paraissait ne rien faire).
    try {
      fs.mkdirSync(folderPath, { recursive: true });
    } catch (e) {
      throw new Error(`Impossible de créer le dossier "${folderPath}" : ${e.message}`);
    }
    // shell.openPath renvoie '' en cas de succès, ou un message d'erreur sinon
    // (sans throw). On retourne ce message pour que l'appelant puisse le
    // remonter à l'utilisateur au lieu d'un échec silencieux.
    const errStr = await shell.openPath(folderPath);
    return errStr;
  }

  static async openFile(filePath) {
    if (fs.existsSync(filePath)) {
      return await shell.openPath(filePath);
    }
    throw new Error(`Le fichier "${filePath}" n'existe pas encore.`);
  }
}

module.exports = { FileManager };