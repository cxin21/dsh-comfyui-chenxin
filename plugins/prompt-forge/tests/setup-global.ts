import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { setAuthorFeedbackDbPath } from '../src/tools/prompt-author.js';
import { setFeedbackDbPath } from '../src/tools/prompt-feedback.js';

/**
 * P2-1（对抗审查）：测试套件不得写 tracked 的 data/runtime/feedback.sqlite。
 * 全局注入 tmp 路径；afterAll 复位（恢复默认解析，不影响真实进程外的一切）。
 * 个别需要自管路径的测试在用例内再 set 即覆盖本注入。
 */
const tmpAuthorDb = join(os.tmpdir(), `pm-vitest-author-feedback-${process.pid}.sqlite`);
const tmpFeedbackDb = join(os.tmpdir(), `pm-vitest-feedback-${process.pid}.sqlite`);
setAuthorFeedbackDbPath(tmpAuthorDb);
setFeedbackDbPath(tmpFeedbackDb);
afterAll(() => {
  setAuthorFeedbackDbPath(null);
  setFeedbackDbPath(null);
});
