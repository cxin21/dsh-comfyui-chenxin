### Task 5: G2 Envelope 鎶曞奖锛堥《灞?phase_status + dialectTopLevel 鍙傦級

**Files:**
- Modify: `src/pe-framework/render/envelope.ts`锛坅ssembleEnvelope 绗洓鍙€夊弬 `dialectTopLevel?: Record<string, unknown>`锛?- Modify: `src/tools/prompt-compile.ts`锛坅nima 鍒嗘敮浠?stage.result 鎻愬彇 phase_status 浼犵粰 envelope 椤跺眰锛?- Test: `tests/pe-framework/pipeline/runStage.test.ts`锛坅ssembleEnvelope 鐢ㄤ緥杩藉姞锛? compile-anima 鏂█椤跺眰 phase_status

**Interfaces:**
- Produces: `assembleEnvelope(stage, trail?, observability?, dialectTopLevel?: Record<string, unknown>)`鈥斺€攄ialectTopLevel 閿苟鍏?envelope 椤跺眰锛堟柟瑷€鐗规湁杞借嵎锛沨3 涓嶄紶鍒欐棤鍙樺寲锛?
- [ ] **Step 1: 澶辫触娴嬭瘯**

```ts
// runStage.test.ts assembleEnvelope describe 杩藉姞锛?it('dialectTopLevel keys merge into envelope top level', () => {
  const s = JSON.parse(assembleEnvelope(
    { ok: true, result: { x: 1 }, gates: [], advisories: [], assumptions: [], targetSlotHint: 't2i.prompt' } as any,
    [], { phase_status: { policy: 'PASS' } },
  ))
  expect(s.phase_status).toEqual({ policy: 'PASS' })
})
// compile-anima.test.ts 杩藉姞锛歳aw.phase_status 瀛樺湪涓?policy='PASS'锛堥《灞傦紝闈?result 鍐咃級
```

- [ ] **Step 2: 纭澶辫触 鈫?Step 3: 瀹炵幇锛坋nvelope 缁勮 `...(dialectTopLevel ?? {})`锛夆啋 compile-anima h3/anima 鍒嗘敮浼?result.phase_status 鈫?Step 4: 閫氳繃**

- [ ] **Step 5: 鍏ㄩ噺 + 鎻愪氦**

```bash
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin add plugins/prompt-master/src/pe-framework/render/envelope.ts plugins/prompt-master/src/tools/prompt-compile.ts plugins/prompt-master/tests
git -C C:/Users/11245/.dsh/.agent-presets/comfyui-chenxin commit -m "feat(prompt-master): G2 envelope top-level phase_status via dialectTopLevel"
```

---

