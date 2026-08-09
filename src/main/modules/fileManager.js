'use strict';

const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

class FileManager {
  static openFolder(folderPath) {
    if (fs.existsSync(folderPath)) {
      shell.openPath(folderPath);
    } else {
      throw new Error(`Le dossier "${folderPath}" n'existe pas encore.`);
    }
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