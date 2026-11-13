const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function build() {
  const baseManifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')
  );

  const targets = ['chrome', 'firefox'];
  const commonFiles = ['content-script.js', 'page-bridge.js'];

  // Optional assets
  const optionalFiles = ['screenshot.png'];

  for (const target of targets) {
    const targetDir = path.join(distDir, target);
    ensureDir(targetDir);

    // Copy script files
    for (const file of commonFiles) {
      const srcPath = path.join(rootDir, file);
      if (fs.existsSync(srcPath)) {
        copyFile(srcPath, path.join(targetDir, file));
      }
    }

    // Copy optional files if present
    for (const file of optionalFiles) {
      const srcPath = path.join(rootDir, file);
      if (fs.existsSync(srcPath)) {
        copyFile(srcPath, path.join(targetDir, file));
      }
    }

    // Build target manifest
    const manifest = JSON.parse(JSON.stringify(baseManifest));

    if (target === 'firefox') {
      manifest.browser_specific_settings = {
        gecko: {
          id: "xhs-favorites-exporter@local",
          strict_min_version: "109.0"
        }
      };
    }

    fs.writeFileSync(
      path.join(targetDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8'
    );

    console.log(`✓ Built for ${target}: dist/${target}`);
  }
}

build();
