// scripts/probe-sqlite-vec.mjs — 探测 node:sqlite 能否加载 sqlite-vec（spec §3.3 运行时探测）
// 期望输出 PROBE_OK → 后续任务走 sqlite-vec 唯一路径；失败则整体退路 hnswlib-node（不留兼容层）。
import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';

const db = new DatabaseSync(':memory:', { allowExtension: true });
db.loadExtension(getLoadablePath());
db.exec('CREATE VIRTUAL TABLE t USING vec0(embedding float[4])');
console.log('PROBE_OK: sqlite-vec loadable via node:sqlite loadExtension');
