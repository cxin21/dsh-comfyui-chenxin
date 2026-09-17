import { describe, expect, it } from 'vitest'
import { collectSpeakerIds, buildDialogue, type DialogueShot } from '../../../src/pe-framework/dialect/h3.js'

function shot(partial: Partial<DialogueShot> & { dialogue: DialogueShot['dialogue'] }): DialogueShot {
  return { what: 'She stands in the rain.', ...partial } as DialogueShot
}

/** 官方对白契约（spec §6.1 / D-U7，源：MiniMax-AI/MiniMax-H3 skills/h3-prompt-writing base-en.txt §4.4） */
describe('dialect 对白契约发射（D-U7）', () => {
  it('collectSpeakerIds：同 who 跨镜同 ID，不同 who 递增，无 who 按出现序独立编号', () => {
    const shots = [
      shot({ dialogue: { text: 'a', language: 'English' }, who: 'Zhou' }),
      shot({ dialogue: { text: 'b', language: 'English' }, who: 'Zhao' }),
      shot({ dialogue: { text: 'c', language: 'English' }, who: 'Zhou' }),
      shot({ dialogue: { text: 'd', language: 'English' } }), // 无 who → 独立编号
    ]
    const m = collectSpeakerIds(shots as never[])
    expect(m.get('Zhou')).toBe('S1')
    expect(m.get('Zhao')).toBe('S2')
    expect(m.get('__anon_3')).toBe('S3')
  })

  it('常规发射：说话人 ID 在 <d> 外，<d> 内只有语言标签+原文', () => {
    const s = shot({ dialogue: { text: 'I get off at the next station.', language: 'English' }, who: 'Zhou' })
    const out = buildDialogue(s, 'S1')
    expect(out).toBe(' Zhou (S1) says: <d>[English] I get off at the next station.</d>')
  })

  it('无 who → The speaker (S1) says: 形式', () => {
    const s = shot({ dialogue: { text: 'Hello.', language: 'English' } })
    expect(buildDialogue(s, 'S1')).toBe(' The speaker (S1) says: <d>[English] Hello.</d>')
  })

  it('voiceover：固定短语 + 闭嘴声明（性别中性 their）', () => {
    const s = shot({ dialogue: { text: 'I still remember that road.', language: 'English', voiceover: true }, who: 'Zhou' })
    const out = buildDialogue(s, 'S1')
    expect(out).toBe(
      ' Zhou (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while their lips remain completely closed.',
    )
  })

  it('continues_across_cut：<d> 后追加 <scenetrans> 跨切声明', () => {
    const s = shot({ dialogue: { text: 'Wait for us!', language: 'English', continues_across_cut: true }, who: 'Zhou' })
    const out = buildDialogue(s, 'S1')
    expect(out).toContain('<scenetrans> the dialogue continues across the cut.')
    expect(out.indexOf('<d>')).toBeLessThan(out.indexOf('<scenetrans>'))
  })

  it('truncated：</d> 后紧跟 <cutoff>', () => {
    const s = shot({ dialogue: { text: 'Wait—', language: 'English', truncated: true }, who: 'Zhou' })
    expect(buildDialogue(s, 'S1')).toBe(' Zhou (S1) says: <d>[English] Wait—</d><cutoff>')
  })

  it('无 dialogue 的 shot 发射空串（不变）', () => {
    const s = shot({ dialogue: undefined as never })
    expect(buildDialogue(s, 'S1')).toBe('')
  })
})
