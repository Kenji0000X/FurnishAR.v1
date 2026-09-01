#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Copy public directory to dist
const publicDir = path.join(__dirname, 'public');
const distDir = path.join(__dirname, 'dist');

// Create dist directory
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy all files from public to dist
function copyDir(src, dst) {
  fs.readdirSync(src).forEach(file => {
    const srcFile = path.join(src, file);
    const dstFile = path.join(dst, file);
    if (fs.statSync(srcFile).isDirectory()) {
      if (!fs.existsSync(dstFile)) fs.mkdirSync(dstFile);
      copyDir(srcFile, dstFile);
    } else {
      fs.copyFileSync(srcFile, dstFile);
    }
  });
}

copyDir(publicDir, distDir);
console.log('✓ Build complete: public/ copied to dist/');
