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

module.exports = {
  sleep,
  randomDelay,
  atomicWriteFileSync,
  cleanText,
};