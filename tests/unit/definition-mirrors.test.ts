import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDefinitionMirrorPath, isDefinitionMirrorUri, rewriteExternalDefinitionResult } from '@src/definition-mirrors.js'

const tempDirs: string[] = []

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-ts-lsp-definition-mirrors-'))
    tempDirs.push(dir)
    return dir
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('definition mirrors', () => {
    it('rewrites node_modules declaration targets to cache mirror uris', () => {
        const cacheRoot = makeTempDir()
        const workspaceRoot = makeTempDir()
        const sourcePath = path.join(workspaceRoot, 'node_modules', '@vue', 'runtime-core', 'dist', 'runtime-core.d.ts')
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
        fs.writeFileSync(sourcePath, 'export declare function computed<T>(getter: () => T): T;\n')

        const rewritten = rewriteExternalDefinitionResult(
            [
                {
                    uri: pathToFileURL(sourcePath).href,
                    range: {
                        start: { line: 0, character: 24 },
                        end: { line: 0, character: 32 }
                    }
                }
            ],
            cacheRoot
        )

        expect(rewritten.rewrites).toHaveLength(1)
        expect(rewritten.result).toEqual([
            {
                uri: rewritten.rewrites[0]!.mirrorUri,
                range: {
                    start: { line: 0, character: 24 },
                    end: { line: 0, character: 32 }
                }
            }
        ])
        expect(isDefinitionMirrorUri(rewritten.rewrites[0]!.mirrorUri, cacheRoot)).toBe(true)
        expect(fs.readFileSync(new URL(rewritten.rewrites[0]!.mirrorUri), 'utf8')).toBe(fs.readFileSync(sourcePath, 'utf8'))
    })

    it('uses supported mirror extensions for declaration files', () => {
        const cacheRoot = makeTempDir()
        const mirrorPath = buildDefinitionMirrorPath('/workspace/node_modules/@vue/runtime-core/dist/runtime-core.d.ts', cacheRoot)

        expect(mirrorPath).toContain(path.join('node_modules', '@vue', 'runtime-core', 'dist'))
        expect(path.basename(mirrorPath)).toBe('runtime-core.d.__mirror.ts')
    })

    it('leaves non-node_modules definitions unchanged', () => {
        const cacheRoot = makeTempDir()
        const original = [
            {
                uri: 'file:///workspace/src/useFeature.ts',
                range: {
                    start: { line: 10, character: 0 },
                    end: { line: 10, character: 9 }
                }
            }
        ]

        const rewritten = rewriteExternalDefinitionResult(original, cacheRoot)

        expect(rewritten.rewrites).toEqual([])
        expect(rewritten.result).toEqual(original)
    })
})
