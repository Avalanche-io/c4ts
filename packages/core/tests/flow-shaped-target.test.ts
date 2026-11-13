import { describe, it, expect } from 'vitest'
import { Manifest } from '../src/manifest.js'
import { encode } from '../src/encoder.js'
import { identifyBytes } from '../src/id.js'
import { createEntry, FlowDirection } from '../src/entry.js'

// A symlink whose target has the shape of a flow target (`host:path`,
// `C:foo`) cannot be told from a flow link when the mode is null. Ruled
// 2026-11-13 (decided by the release lead; reversible; link-target-vector
// README, c4 #158 at 7cdc9f3): under a null mode the line is a flow link,
// and under lrwxrwxrwx it is the symlink, so a writer keeps a symlink's
// type by writing its mode. Go pins both readings in
// TestAFlowShapedTargetIsALinkOnlyUnderASymlinkMode; this is the same
// test, and each line c4ts writes is the line Go writes (measured on c4
// b17c393).

const GO_ID = 'c45WurN5j5WeFqxZMB8ZY9p4D2Ks9rNTEmbXFihjWmCJjDM66pNmRYvW41hGt1Bzj8iJ8WsqyXwNmH7VAJSjvwV91v'

describe('a flow-shaped target is a symlink only under a symlink mode', () => {
  for (const target of ['host:path', 'C:foo', 'studio:inbox/']) {
    for (const withID of [false, true]) {
      it(`${target}${withID ? ' with a C4 ID' : ''}`, async () => {
        const content = await identifyBytes(new TextEncoder().encode('what the link points at'))
        expect(content.toString()).toBe(GO_ID)
        const c4id = withID ? content : null
        const idField = withID ? GO_ID : '-'

        // Under lrwxrwxrwx the line reads back as the symlink.
        const sym = Manifest.create()
        sym.entries.push(createEntry({ name: 'link', modeType: 'l', mode: 0o777, target, c4id }))
        const symText = encode(sym)
        expect(symText).toBe(`lrwxrwxrwx - - link -> ${target} ${idField}\n`)
        const symBack = (await Manifest.parse(symText)).entries[0]
        expect(symBack.modeType).toBe('l')
        expect(symBack.target).toBe(target)
        expect(symBack.flowDirection).toBe(FlowDirection.None)
        expect(symBack.flowTarget).toBe('')

        // Under a null mode the same line is a flow link to that location.
        const flowText = `- - - link -> ${target} ${idField}\n`
        const flowBack = (await Manifest.parse(flowText)).entries[0]
        expect(flowBack.flowDirection).toBe(FlowDirection.Outbound)
        expect(flowBack.flowTarget).toBe(target)
        expect(flowBack.target).toBe('')
        expect(flowBack.modeType).toBe('-')
        // and c4ts writes that flow link as the same line.
        const flow = Manifest.create()
        flow.entries.push(createEntry({ name: 'link', flowDirection: FlowDirection.Outbound, flowTarget: target, c4id }))
        expect(encode(flow)).toBe(flowText)
      })
    }
  }
})
