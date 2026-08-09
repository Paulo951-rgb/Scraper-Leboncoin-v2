'use strict';

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const jitter = Math.floor(Math.random() * 500);
  return sleep(minMs + Math.random() * Math.max(0, maxMs - minMs) + jitter);
}

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function cleanText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}min ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}min`;
}

function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: poolSize }, () => runNext());

  return Promise.all(workers).then(() => results);
}

module.exports = {
  sleep,
  randomDelay,
  atomicWriteFileSync,
  cleanText,
  formatDuration,
  runWithConcurrency,
};