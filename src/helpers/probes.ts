import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { VueImportTarget, DefinitionProbe } from './types.js'

export const INTERNAL_PROBE_MARKER = '.__vue_ts_lsp__.'
export const PROBE_LOCAL_NAME = '__vue_ts_lsp_probe__'

export function createDefinitionProbe(sourceUri: string, target: VueImportTarget): DefinitionProbe {
    const importLine = buildProbeImportLine(target)
    return {
        uri: buildProbeUri(sourceUri),
        text: `${importLine}\n${PROBE_LOCAL_NAME};\n`,
        position: { line: 1, character: 0 }
    }
}

export function isInternalProbeUri(uri: string): boolean {
    return uri.includes(INTERNAL_PROBE_MARKER)
}

function buildProbeImportLine(target: VueImportTarget): string {
    const moduleSpecifier = `'${target.moduleSpecifier.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    switch (target.importKind) {
        case 'named':
            return `import { ${target.importedName ?? target.localName} as ${PROBE_LOCAL_NAME} } from ${moduleSpecifier};`
        case 'default':
            return `import ${PROBE_LOCAL_NAME} from ${moduleSpecifier};`
        case 'namespace':
            return `import * as ${PROBE_LOCAL_NAME} from ${moduleSpecifier};`
    }
}

function buildProbeUri(sourceUri: string): string {
    try {
        const sourcePath = fileURLToPath(sourceUri)
        const dir = path.dirname(sourcePath)
        const base = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_')
        return pathToFileURL(path.join(dir, `${INTERNAL_PROBE_MARKER}${base}.ts`)).href
    } catch {
        return `${sourceUri}${INTERNAL_PROBE_MARKER}ts`
    }
}
