#!/usr/bin/env node
/**
 * 部署：待推送的 commit 若有改到 src/，先 clasp push 到 Apps Script，再 git push。
 * 用法：npm run deploy [-- <git push 參數>]
 */
const { execSync } = require('child_process');

const run = cmd => execSync(cmd, { stdio: 'inherit' });
const ok = cmd => {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// src/ 有未 commit 的修改就中止，確保 Apps Script 與 GitHub 是同一份程式
if (execSync('git status --porcelain -- src').toString().trim()) {
  console.error('✗ src/ 有尚未 commit 的修改，請先 commit 再部署。');
  process.exit(1);
}

// 沒有 upstream（第一次推送）視為有變動
const hasUpstream = ok('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
const srcChanged = !hasUpstream || !ok('git diff --quiet @{u} HEAD -- src');

try {
  if (srcChanged) {
    console.log('▶ src/ 有變動，推送到 Apps Script…');
    run('npm run push');
  } else {
    console.log('▶ src/ 沒有變動，略過 clasp push');
  }
  console.log('▶ git push');
  run(['git push', ...process.argv.slice(2)].join(' '));
} catch {
  process.exit(1);
}
