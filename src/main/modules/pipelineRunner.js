'use strict';

const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

class PipelineRunner extends EventEmitter {
  constructor() {
    super();
    this.childProcess = null;
    this.isCancelled = false;
  }

  run(options) {
    return new Promise((resolve, reject) => {
      const { harPath, outDir, noDesc = false, csv = true, limit, fresh = false } = options;

      if (!harPath) return reject(new Error('harPath est requis pour exécuter le pipeline.'));
      if (!outDir) return reject(new Error('outDir est requis pour exécuter le pipeline.'));

      const scriptPath = path.join(__dirname, '../vendor/leboncoin-pipeline.js');

      // fork() gère de manière native et parfaite les espaces dans les chemins Windows !
      // Le premier argument de fork est le script, le deuxième est le tableau des arguments restants (harPath, --out, etc.)
      // On ajoute --headless pour que l'extraction des descriptions soit invisible
      const remainingArgs = [harPath, '--out', outDir, '--headless']; 

      if (noDesc) remainingArgs.push('--no-desc');
      if (csv) remainingArgs.push('--csv');
      if (fresh) remainingArgs.push('--fresh');
      if (limit) remainingArgs.push('--limit', String(limit));

      this.emit('log', {
        level: 'info',
        message: `⚙️ Lancement du pipeline sous-processus (Moteur de fork sécurisé)...`,
      });

      this.isCancelled = false;
      this.childProcess = fork(scriptPath, remainingArgs, {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'] // Redirige les flux pour capturer la progression
      });

      let stdoutBuffer = '';

      this.childProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop();

        for (const rawLine of lines) {
          this._handleLine(rawLine);
        }
      });

      let stderrBuffer = '';
      this.childProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString('utf8');
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop();

        for (const rawLine of lines) {
          const clean = stripAnsi(rawLine).trim();
          if (clean) {
            this.emit('log', { level: 'error', message: `[Pipeline STDERR] ${clean}` });
          }
        }
      });

      this.childProcess.on('error', (err) => {
        this.emit('log', { level: 'error', message: `Erreur processus : ${err.message}` });
        reject(err);
      });

      this.childProcess.on('close', (code) => {
        if (stdoutBuffer.trim()) this._handleLine(stdoutBuffer);

        this.childProcess = null;

        if (this.isCancelled) {
          this.emit('log', { level: 'warn', message: 'Pipeline annulé par l\'utilisateur.' });
          resolve(130);
          return;
        }

        if (code === 0) {
          this.emit('log', { level: 'info', message: '✅ Execution du pipeline terminée avec succès.' });
          resolve(0);
        } else {
          const errMessage = `Le pipeline s'est terminé avec un code : ${code}`;
          this.emit('log', { level: 'error', message: errMessage });
          reject(new Error(errMessage));
        }
      });
    });
  }

  stop() {
    if (this.childProcess) {
      this.isCancelled = true;
      this.emit('log', { level: 'warn', message: 'Interruption demandée du pipeline...' });
      this.childProcess.kill('SIGINT');
    }
  }

  _handleLine(rawLine) {
    const clean = stripAnsi(rawLine).trim();
    if (!clean) return;

    let level = 'info';
    if (clean.includes('[WARN]')) level = 'warn';
    else if (clean.includes('[ERROR]')) level = 'error';
    else if (clean.includes('[DEBUG]')) level = 'debug';

    this.emit('log', { level, message: clean });

    // Progression
    const match = clean.match(/\[(\d+)\/(\d+)\]/);
    if (match) {
      const done = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;

      this.emit('progress', {
        done,
        total,
        percent,
        status: `Traitement : ${done}/${total} (${percent}%)`,
      });
    }
  }
}

module.exports = { PipelineRunner };