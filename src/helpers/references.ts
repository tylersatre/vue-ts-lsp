import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Position, Range } from 'vscode-languageserver-protocol'

import type { ReferenceTarget, ReferenceTargetKind, TextDocumentContentChangeLike } from './types.js'
import {
    lineCharToOffset,
    offsetToPosition,
    offsetsToRange,
    clampPositionToText,
    inferReplacementProbeOffsets,
    rangeContains,
    rangeSpan
} from './position-utils.js'
import { findNodeAtOffset, collectParseTargets, getExtension, isFunctionLikeInitializer, hasExportModifier } from './ast-utils.js'
import { isIdentifierChar, extractIdentifierAtPosition } from './identifiers.js'
import { collectVueTemplateIdentifierRanges } from './vue-template.js'
import { findVueTemplateComponentAtPosition } from './vue-template.js'

function rangeForIdentifierAtPosition(text: string, position: Position): Range | null {
    const offset = lineCharToOffset(text, position)
    const current = text[offset] ?? ''
    const previous = text[offset - 1] ?? ''
    const seedOffset = isIdentifierChar(current) ? offset : isIdentifierChar(previous) ? offset - 1 : -1

    if (seedOffset < 0) {
        return null
    }

    let start = seedOffset
    let end = seedOffset + 1
    while (start > 0 && isIdentifierChar(text[start - 1] ?? '')) {
        start -= 1
    }
    while (end < text.length && isIdentifierChar(text[end] ?? '')) {
        end += 1
    }

    return start < end ? offsetsToRange(text, start, end) : null
}

function inferVueComponentNameFromUri(uri: string): string | null {
    if (getExtension(uri) !== '.vue') {
        return null
    }

    const filePath = (() => {
        try {
            return fileURLToPath(uri)
        } catch {
            return uri
        }
    })()
    const baseName = path.basename(filePath, '.vue')
    if (baseName.length === 0) {
        return null
    }
    if (/^[A-Z]/.test(baseName)) {
        return baseName
    }
    return baseName
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join('')
}

function buildReferenceTargetMatch(node: ts.Node, sourceFile: ts.SourceFile, contentStart: number, text: string): ReferenceTarget | null {
    if (ts.isTypeAliasDeclaration(node)) {
        return buildReferenceTarget('type-alias', node.name.text, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isInterfaceDeclaration(node)) {
        return buildReferenceTarget('interface', node.name.text, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isEnumDeclaration(node)) {
        return buildReferenceTarget('enum', node.name.text, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        return buildReferenceTarget('function', node.name.text, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        return buildReferenceTarget(
            isFunctionLikeInitializer(node.initializer) ? 'function' : 'variable',
            node.name.text,
            node,
            node.name,
            sourceFile,
            contentStart,
            text
        )
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        return buildReferenceTarget('method', node.name.text, node, node.name, sourceFile, contentStart, text)
    }

    return null
}

function buildReferenceTarget(
    kind: ReferenceTargetKind,
    name: string,
    rangeNode: ts.Node,
    selectionNode: ts.Node,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string
): ReferenceTarget {
    const rangeStart = contentStart + rangeNode.getStart(sourceFile)
    const rangeEnd = contentStart + rangeNode.getEnd()
    const selectionStart = contentStart + selectionNode.getStart(sourceFile)
    const selectionEnd = contentStart + selectionNode.getEnd()

    return {
        name,
        kind,
        exported: hasExportModifier(rangeNode),
        range: offsetsToRange(text, rangeStart, rangeEnd),
        selectionRange: offsetsToRange(text, selectionStart, selectionEnd)
    }
}

export function findReferenceTargetAtPosition(uri: string, text: string, position: Position): ReferenceTarget | null {
    const componentName = getExtension(uri) === '.vue' ? findVueTemplateComponentAtPosition(text, position) : null
    if (componentName !== null) {
        const range = rangeForIdentifierAtPosition(text, position)
        if (range !== null) {
            return {
                name: componentName,
                kind: 'component',
                exported: true,
                range,
                selectionRange: range
            }
        }
    }

    if (getExtension(uri) === '.vue' && position.line === 0 && position.character <= 1) {
        const inferredComponentName = inferVueComponentNameFromUri(uri)
        if (inferredComponentName !== null) {
            const range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            }
            return {
                name: inferredComponentName,
                kind: 'component',
                exported: true,
                range,
                selectionRange: range
            }
        }
    }

    const documentOffset = lineCharToOffset(text, position)
    for (const target of collectParseTargets(uri, text)) {
        const localOffset = documentOffset - target.contentStart
        if (localOffset < 0 || localOffset > target.content.length) {
            continue
        }

        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)
        const node = findNodeAtOffset(sourceFile, localOffset)
        if (node === null) {
            continue
        }

        let current: ts.Node | undefined = node
        while (current !== undefined) {
            const match = buildReferenceTargetMatch(current, sourceFile, target.contentStart, text)
            if (match !== null) {
                return match
            }
            current = current.parent
        }
    }

    const identifier = extractIdentifierAtPosition(text, position)
    const range = rangeForIdentifierAtPosition(text, position)
    if (identifier !== null && range !== null) {
        return {
            name: identifier,
            kind: 'variable',
            exported: false,
            range,
            selectionRange: range
        }
    }

    return null
}

export function findEnclosingReferenceTargetAtPosition(uri: string, text: string, position: Position): ReferenceTarget | null {
    let best: ReferenceTarget | null = null

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            const match = buildReferenceTargetMatch(node, sourceFile, target.contentStart, text)
            if (match !== null && rangeContains(match.range, position)) {
                if (best === null || rangeSpan(match.range) < rangeSpan(best.range)) {
                    best = match
                }
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    return best
}

export function collectIdentifierReferencesInDocument(uri: string, text: string, identifier: string): Array<{ uri: string; range: Range }> {
    const locations: Array<{ uri: string; range: Range }> = []
    const seen = new Set<string>()

    const pushLocation = (range: Range): void => {
        const key = `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`
        if (seen.has(key)) {
            return
        }
        seen.add(key)
        locations.push({ uri, range })
    }

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && node.text === identifier) {
                const start = target.contentStart + node.getStart(sourceFile)
                const end = target.contentStart + node.getEnd()
                pushLocation(offsetsToRange(text, start, end))
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    if (getExtension(uri) === '.vue') {
        for (const range of collectVueTemplateIdentifierRanges(text, identifier)) {
            pushLocation(range)
        }
    }

    return locations
}

export function collectReferenceTargetsForChanges(
    uri: string,
    oldText: string | null,
    newText: string,
    changes: ReadonlyArray<TextDocumentContentChangeLike>
): ReferenceTarget[] {
    const probes: Array<{
        text: string
        position: Position
        source: 'old' | 'new'
    }> = []
    const seenProbes = new Set<string>()
    const pushProbe = (source: 'old' | 'new', text: string, position: Position): void => {
        const clamped = clampPositionToText(text, position)
        const key = `${source}:${clamped.line}:${clamped.character}`
        if (seenProbes.has(key)) {
            return
        }
        seenProbes.add(key)
        probes.push({ text, position: clamped, source })
    }

    for (const change of changes) {
        if (change.range !== undefined) {
            pushProbe('new', newText, change.range.start)
            if (oldText !== null) {
                pushProbe('old', oldText, change.range.start)
            }
            continue
        }

        if (oldText === null) {
            pushProbe('new', newText, { line: 0, character: 0 })
            continue
        }

        const diff = inferReplacementProbeOffsets(oldText, newText)
        if (diff === null) {
            pushProbe('new', newText, { line: 0, character: 0 })
            pushProbe('old', oldText, { line: 0, character: 0 })
            continue
        }

        for (const offset of diff.newOffsets) {
            pushProbe('new', newText, offsetToPosition(newText, offset))
        }
        for (const offset of diff.oldOffsets) {
            pushProbe('old', oldText, offsetToPosition(oldText, offset))
        }
    }

    const targets: ReferenceTarget[] = []
    const seenTargets = new Set<string>()
    for (const probe of probes) {
        const target = findReferenceTargetAtPosition(uri, probe.text, probe.position) ?? findEnclosingReferenceTargetAtPosition(uri, probe.text, probe.position)
        if (target === null) {
            continue
        }

        const key = [
            target.name,
            target.kind,
            target.selectionRange.start.line,
            target.selectionRange.start.character,
            target.selectionRange.end.line,
            target.selectionRange.end.character
        ].join(':')
        if (seenTargets.has(key)) {
            continue
        }

        seenTargets.add(key)
        targets.push(target)
    }

    return targets
}
