'use strict';

/**
 * 总测试入口：先单元测试（必须全过），再在线实测（单项独立报告）。
 * 运行：node tests/run.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

console.log('========== 单元测试（mock，无需网络） ==========');
const unit = spawnSync(process.execPath, [path.join(__dirname, 'unit.js')], { stdio: 'inherit' });
if (unit.status !== 0) {
  console.error('\n[失败] 单元测试未通过，停止后续测试');
  process.exit(unit.status || 1);
}

console.log('\n\n========== 在线实测（真实链接） ==========');
const live = spawnSync(process.execPath, [path.join(__dirname, 'live.js')], { stdio: 'inherit', timeout: 180000 });
// 在线实测失败不阻塞整体（平台限流常见），但给出提示
if (live.status !== 0) {
  console.log('\n[提示] 在线实测部分未通过，详见上方输出（多为平台限流/链接失效）。');
}
console.log('\n全部测试完成。');
