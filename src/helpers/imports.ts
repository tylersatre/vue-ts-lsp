import ts from 'typescript'
import type { Position } from 'vscode-languageserver-protocol'

import type { VueImportTarget, ResolvedVueImportTarget } from './types.js'
import { lineCharToOffset, offsetToPosition, distanceToRange } from './position-utils.js'
import { findScriptBlockAtOffset, findFirstScriptBlock, findNodeAtOffset, collectParseTargets, getModuleSpecifier } from './ast-utils.js'

interface ImportCandidate {
    target: VueImportTarget
    selectionOffset: number
    rangeStart: number
    rangeEnd: number
}

export function findVueImportAtPosition(text: string, position: Position): VueImportTarget | null {
    const target = resolveImportTarget(text, position, 'vue')
    if (target === null) {
        return null
    }
    return {
        moduleSpecifier: target.moduleSpecifier,
        importKind: target.importKind,
        importedName: target.importedName,
        localName: target.localName
    }
}

export function normalizeVueImportPosition(text: string, position: Position): Position | null {
    return resolveImportTarget(text, position, 'vue')?.selectionPosition ?? null
}

export function findImportAtPosition(text: string, position: Position): VueImportTarget | null {
    const target = resolveImportTarget(text, position, 'file')
    if (target === null) {
        return null
    }
    return {
        moduleSpecifier: target.moduleSpecifier,
        importKind: target.importKind,
        importedName: target.importedName,
        localName: target.localName
    }
}

export function normalizeImportPosition(text: string, position: Position): Position | null {
    return resolveImportTarget(text, position, 'file')?.selectionPosition ?? null
}

export function findImportByLocalName(text: string, localName: string): VueImportTarget | null {
    const scriptBlock = findFirstScriptBlock(text)
    if (scriptBlock === null) {
        return null
    }

    const sourceFile = ts.createSourceFile('component.ts', scriptBlock.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    let match: VueImportTarget | null = null
    const visit = (node: ts.Node): void => {
        if (match !== null) {
            return
        }
        if (!ts.isImportDeclaration(node)) {
            ts.forEachChild(node, visit)
            return
        }

        const moduleSpecifier = getModuleSpecifier(node)
        const importClause = node.importClause
        if (moduleSpecifier === null || importClause === undefined) {
            return
        }

        if (importClause.name?.text === localName) {
            match = {
                moduleSpecifier,
                importKind: 'default',
                importedName: null,
                localName
            }
            return
        }

        const namedBindings = importClause.namedBindings
        if (namedBindings === undefined) {
            return
        }

        if (ts.isNamespaceImport(namedBindings) && namedBindings.name.text === localName) {
            match = {
                moduleSpecifier,
                importKind: 'namespace',
                importedName: null,
                localName
            }
            return
        }

        if (ts.isNamedImports(namedBindings)) {
            const namedImport = namedBindings.elements.find((element) => element.name.text === localName)
            if (namedImport !== undefined) {
                match = {
                    moduleSpecifier,
                    importKind: 'named',
                    importedName: namedImport.propertyName?.text ?? namedImport.name.text,
                    localName
                }
            }
        }
    }

    visit(sourceFile)
    return match
}

export function collectImportedModuleSpecifiers(uri: string, text: string): string[] {
    const moduleSpecifiers: string[] = []
    const seen = new Set<string>()

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                const moduleSpecifier = getModuleSpecifier(node)
                if (moduleSpecifier !== null && !seen.has(moduleSpecifier)) {
                    seen.add(moduleSpecifier)
                    moduleSpecifiers.push(moduleSpecifier)
                }
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    return moduleSpecifiers
}

function resolveImportTarget(text: string, position: Position, mode: 'vue' | 'file'): ResolvedVueImportTarget | null {
    const documentOffset = lineCharToOffset(text, position)

    const parseTarget = mode === 'vue' ? findScriptBlockAtOffset(text, documentOffset) : { content: text, contentStart: 0 }
    if (parseTarget === null) {
        return null
    }

    const sourceFile = ts.createSourceFile('component.ts', parseTarget.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const node = findNodeAtOffset(sourceFile, documentOffset - parseTarget.contentStart)
    if (node === null) {
        return null
    }

    const localOffset = documentOffset - parseTarget.contentStart
    let current: ts.Node | undefined = node
    let nearestImportDeclaration: ts.ImportDeclaration | null = null
    while (current !== undefined) {
        if (ts.isImportDeclaration(current)) {
            nearestImportDeclaration = current
        }

        const exactMatch = buildResolvedImportTarget(current, sourceFile, parseTarget.contentStart, text, localOffset)
        if (exactMatch !== null) {
            return exactMatch
        }

        current = current.parent
    }

    return nearestImportDeclaration === null ? null : findNearestImportTarget(nearestImportDeclaration, sourceFile, parseTarget.contentStart, text, localOffset)
}

function buildResolvedImportTarget(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    localOffset: number
): ResolvedVueImportTarget | null {
    if (ts.isImportSpecifier(node)) {
        const importDeclaration = node.parent.parent.parent
        if (!ts.isImportDeclaration(importDeclaration)) {
            return null
        }
        const candidate = buildImportSpecifierCandidate(node, importDeclaration, sourceFile, localOffset)
        return candidate === null ? null : resolvedCandidateToTarget(candidate, contentStart, text)
    }

    if (ts.isNamespaceImport(node)) {
        const importDeclaration = node.parent.parent
        if (!ts.isImportDeclaration(importDeclaration)) {
            return null
        }
        return resolvedCandidateToTarget(buildNamespaceImportCandidate(node, importDeclaration, sourceFile), contentStart, text)
    }

    if (ts.isImportClause(node) && node.name !== undefined) {
        const importDeclaration = node.parent
        if (!ts.isImportDeclaration(importDeclaration)) {
            return null
        }
        return resolvedCandidateToTarget(buildDefaultImportCandidate(node, importDeclaration, sourceFile), contentStart, text)
    }

    return null
}

function findNearestImportTarget(
    importDeclaration: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    localOffset: number
): ResolvedVueImportTarget | null {
    const candidates = buildImportCandidates(importDeclaration, sourceFile, localOffset)
    if (candidates.length === 0) {
        return null
    }

    candidates.sort((a, b) => {
        const distanceDiff = distanceToRange(localOffset, a.rangeStart, a.rangeEnd) - distanceToRange(localOffset, b.rangeStart, b.rangeEnd)
        if (distanceDiff !== 0) {
            return distanceDiff
        }
        return Math.abs(localOffset - a.selectionOffset) - Math.abs(localOffset - b.selectionOffset)
    })

    return resolvedCandidateToTarget(candidates[0]!, contentStart, text)
}

function buildImportCandidates(importDeclaration: ts.ImportDeclaration, sourceFile: ts.SourceFile, localOffset: number): ImportCandidate[] {
    const importClause = importDeclaration.importClause
    if (importClause === undefined) {
        return []
    }

    const candidates: ImportCandidate[] = []
    if (importClause.name !== undefined) {
        candidates.push(buildDefaultImportCandidate(importClause, importDeclaration, sourceFile))
    }

    const namedBindings = importClause.namedBindings
    if (namedBindings === undefined) {
        return candidates
    }

    if (ts.isNamespaceImport(namedBindings)) {
        candidates.push(buildNamespaceImportCandidate(namedBindings, importDeclaration, sourceFile))
        return candidates
    }

    for (const element of namedBindings.elements) {
        const candidate = buildImportSpecifierCandidate(element, importDeclaration, sourceFile, localOffset)
        if (candidate !== null) {
            candidates.push(candidate)
        }
    }

    return candidates
}

function buildDefaultImportCandidate(importClause: ts.ImportClause, importDeclaration: ts.ImportDeclaration, sourceFile: ts.SourceFile): ImportCandidate {
    const moduleSpecifier = getModuleSpecifier(importDeclaration)!
    const name = importClause.name!
    return {
        target: {
            moduleSpecifier,
            importKind: 'default',
            importedName: null,
            localName: name.text
        },
        selectionOffset: name.getStart(sourceFile),
        rangeStart: name.getStart(sourceFile),
        rangeEnd: name.getEnd()
    }
}

function buildNamespaceImportCandidate(
    namespaceImport: ts.NamespaceImport,
    importDeclaration: ts.ImportDeclaration,
    sourceFile: ts.SourceFile
): ImportCandidate {
    const moduleSpecifier = getModuleSpecifier(importDeclaration)!
    return {
        target: {
            moduleSpecifier,
            importKind: 'namespace',
            importedName: null,
            localName: namespaceImport.name.text
        },
        selectionOffset: namespaceImport.name.getStart(sourceFile),
        rangeStart: namespaceImport.name.getStart(sourceFile),
        rangeEnd: namespaceImport.name.getEnd()
    }
}

function buildImportSpecifierCandidate(
    importSpecifier: ts.ImportSpecifier,
    importDeclaration: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    localOffset: number
): ImportCandidate | null {
    const moduleSpecifier = getModuleSpecifier(importDeclaration)
    if (moduleSpecifier === null) {
        return null
    }

    const importedNode = importSpecifier.propertyName ?? importSpecifier.name
    const localNode = importSpecifier.name
    const importedRangeStart = importedNode.getStart(sourceFile)
    const importedRangeEnd = importedNode.getEnd()
    const localRangeStart = localNode.getStart(sourceFile)
    const localRangeEnd = localNode.getEnd()
    const importedDistance = distanceToRange(localOffset, importedRangeStart, importedRangeEnd)
    const localDistance = distanceToRange(localOffset, localRangeStart, localRangeEnd)

    return {
        target: {
            moduleSpecifier,
            importKind: 'named',
            importedName: importSpecifier.propertyName?.text ?? importSpecifier.name.text,
            localName: importSpecifier.name.text
        },
        selectionOffset: importedDistance <= localDistance ? importedRangeStart : localRangeStart,
        rangeStart: importSpecifier.getStart(sourceFile),
        rangeEnd: importSpecifier.getEnd()
    }
}

function resolvedCandidateToTarget(candidate: ImportCandidate, contentStart: number, text: string): ResolvedVueImportTarget {
    return {
        ...candidate.target,
        selectionPosition: offsetToPosition(text, contentStart + candidate.selectionOffset)
    }
}
