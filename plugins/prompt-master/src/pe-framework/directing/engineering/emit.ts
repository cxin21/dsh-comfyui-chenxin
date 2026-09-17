/**
 * 工程落盘（spec 2026-09-17-h3-agentic-directing-pipeline-design §4 工程输出物）：
 * 三件套 = storyboard.json（DirectingIR 序列化）+ prompts/<shotId>.txt（有 prompt 的 shot）+ continuity-ledger.json。
 * 幂等重跑覆盖（不追加不残留）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DirectingIr } from '../ir-schema.js';

export interface EmitResult {
  storyboardPath: string;
  promptPaths: string[];
  ledgerPath: string;
}

export function emitEngineering(baseDir: string, ir: DirectingIr): EmitResult {
  const promptsDir = join(baseDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  const storyboardPath = join(baseDir, 'storyboard.json');
  writeFileSync(storyboardPath, JSON.stringify(ir, null, 2) + '\n', 'utf8');

  const promptPaths: string[] = [];
  for (const beat of ir.beats) {
    for (const shot of beat.shots) {
      if (shot.prompt?.text) {
        const p = join(promptsDir, `${shot.id}.txt`);
        writeFileSync(p, shot.prompt.text + '\n', 'utf8');
        promptPaths.push(p);
      }
    }
  }

  const ledgerPath = join(baseDir, 'continuity-ledger.json');
  writeFileSync(ledgerPath, JSON.stringify(ir.continuity_ledger, null, 2) + '\n', 'utf8');

  return { storyboardPath, promptPaths, ledgerPath };
}
