#!/usr/bin/env node
'use strict';
// Summarises a V8 .cpuprofile into self-time by function, so the load test's
// hot path can be named rather than guessed.
const fs = require('fs');
const file = process.argv[2];
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map(n => [n.id, n]));
const self = new Map();
// timeDeltas[i] is the time spent before samples[i]
for (let i = 0; i < prof.samples.length; i++) {
  const n = byId.get(prof.samples[i]);
  if (!n) continue;
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').replace(/.*\/(node_modules\/)?/, '$1')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (prof.timeDeltas[i] || 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3] || 30));
console.log(`total sampled: ${(total / 1000).toFixed(0)}ms`);
for (const [k, v] of rows) {
  console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${(v / 1000).toFixed(0).padStart(6)}ms  ${k}`);
}
