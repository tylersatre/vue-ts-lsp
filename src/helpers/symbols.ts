import ts from 'typescript'
import type { DocumentSymbol, Position, SymbolKind, SymbolInformation } from 'vscode-languageserver-protocol'
import type { SymbolMatch } from './types.js'
import { offsetToPosition, rangeContains, rangeSpan } from './position-utils.js'
import { collectParseTargets, isFunctionLikeInitializer } from './ast-utils.js'

export function findBestSymbolAtPosition(symbols: unknown, position: Position, fallbackUri: string): SymbolMatch | null {
    let best: SymbolMatch | null = null

    for (const symbol of normalizeSymbols(symbols, fallbackUri)) {
        if (!rangeContains(symbol.range, position)) {
            continue
        }
        if (best === null || rangeSpan(symbol.range) < rangeSpan(best.range)) {
            best = symbol
        }
    }

    return best
}

export function findSymbolByName(symbols: unknown, name: string, fallbackUri: string): SymbolMatch | null {
    return normalizeSymbols(symbols, fallbackUri).find((symbol) => symbol.name === name) ?? null
}

export function findScriptSymbolByName(text: string, name: string, uri: string): SymbolMatch | null {
    let best: SymbolMatch | null = null

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            const candidate = buildScriptSymbolMatch(node, sourceFile, target.contentStart, text, uri)
            if (candidate !== null && candidate.name === name) {
                if (best === null || rangeSpan(candidate.range) < rangeSpan(best.range)) {
                    best = candidate
                }
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    return best
}

export function collectWorkspaceSymbols(text: string, uri: string): SymbolMatch[] {
    const matches: SymbolMatch[] = []
    const seen = new Set<string>()

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            const match = buildWorkspaceSymbolMatch(node, sourceFile, target.contentStart, text, uri)
            if (match !== null) {
                const key = `${match.uri}:${match.name}:${match.selectionRange.start.line}:${match.selectionRange.start.character}`
                if (!seen.has(key)) {
                    seen.add(key)
                    matches.push(match)
                }
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    return matches
}

export function normalizeDocumentSymbolKinds(uri: string, text: string, symbols: unknown): unknown {
    if (!Array.isArray(symbols)) {
        return symbols
    }

    const overrides = collectDocumentSymbolKindOverrides(uri, text)
    if (overrides.size === 0) {
        return symbols
    }

    return symbols.map((symbol) => normalizeDocumentSymbolKind(symbol, overrides))
}

export function buildNamedSymbolMatch(
    uri: string,
    name: string,
    kind: number,
    rangeNode: ts.Node,
    selectionNode: ts.Node,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string
): SymbolMatch {
    const rangeStart = contentStart + rangeNode.getStart(sourceFile)
    const rangeEnd = contentStart + rangeNode.getEnd()
    const selectionStart = contentStart + selectionNode.getStart(sourceFile)
    const selectionEnd = contentStart + selectionNode.getEnd()

    return {
        uri,
        name,
        kind,
        range: {
            start: offsetToPosition(text, rangeStart),
            end: offsetToPosition(text, rangeEnd)
        },
        selectionRange: {
            start: offsetToPosition(text, selectionStart),
            end: offsetToPosition(text, selectionEnd)
        },
        detail: ''
    }
}

export function findLocalDeclarationMatch(
    scopeNode: ts.Node,
    name: string,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    let match: SymbolMatch | null = null
    const visit = (node: ts.Node): void => {
        if (match !== null) {
            return
        }
        if (node !== scopeNode && ts.isFunctionLike(node)) {
            return
        }
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
            match = buildNamedSymbolMatch(uri, node.name.text, 12, node, node.name, sourceFile, contentStart, text)
            return
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
            match = buildNamedSymbolMatch(
                uri,
                node.name.text,
                isFunctionLikeInitializer(node.initializer) ? 12 : 13,
                node,
                node.name,
                sourceFile,
                contentStart,
                text
            )
            return
        }
        ts.forEachChild(node, visit)
    }

    visit(scopeNode)
    return match
}

function normalizeSymbols(symbols: unknown, fallbackUri: string): SymbolMatch[] {
    if (!Array.isArray(symbols)) {
        return []
    }

    const normalized: SymbolMatch[] = []

    const visitDocumentSymbol = (symbol: DocumentSymbol): void => {
        normalized.push({
            uri: fallbackUri,
            name: symbol.name,
            kind: symbol.kind,
            range: symbol.range,
            selectionRange: symbol.selectionRange,
            detail: symbol.detail
        })
        for (const child of symbol.children ?? []) {
            visitDocumentSymbol(child)
        }
    }

    for (const symbol of symbols) {
        if (symbol === null || typeof symbol !== 'object') {
            continue
        }

        if ('location' in symbol) {
            const info = symbol as SymbolInformation
            normalized.push({
                uri: info.location.uri,
                name: info.name,
                kind: info.kind,
                range: info.location.range,
                selectionRange: info.location.range,
                detail: info.containerName
            })
            continue
        }

        if ('range' in symbol && 'selectionRange' in symbol) {
            visitDocumentSymbol(symbol as DocumentSymbol)
        }
    }

    return normalized
}

function collectDocumentSymbolKindOverrides(uri: string, text: string): Map<string, SymbolKind> {
    const overrides = new Map<string, SymbolKind>()

    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)

        const visit = (node: ts.Node): void => {
            const named = getNamedSymbolOverride(node)
            if (named !== null) {
                const start = target.contentStart + named.node.getStart(sourceFile)
                const position = offsetToPosition(text, start)
                overrides.set(symbolKindKey(named.name, position), named.kind)
            }
            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
    }

    return overrides
}

function normalizeDocumentSymbolKind(symbol: unknown, overrides: Map<string, SymbolKind>): unknown {
    if (symbol === null || typeof symbol !== 'object') {
        return symbol
    }

    if ('location' in symbol) {
        const info = symbol as SymbolInformation
        const override = overrides.get(symbolKindKey(info.name, info.location.range.start))
        return override === undefined ? symbol : { ...info, kind: override }
    }

    if (!('range' in symbol) || !('selectionRange' in symbol)) {
        return symbol
    }

    const documentSymbol = symbol as DocumentSymbol
    const override = overrides.get(symbolKindKey(documentSymbol.name, documentSymbol.selectionRange.start))
    const normalizedChildren = documentSymbol.children?.map((child) => normalizeDocumentSymbolKind(child, overrides) as DocumentSymbol)
    const nextKind = override ?? documentSymbol.kind
    const childrenChanged = normalizedChildren !== undefined && normalizedChildren.some((child, index) => child !== documentSymbol.children?.[index])

    if (nextKind === documentSymbol.kind && !childrenChanged) {
        return symbol
    }

    return {
        ...documentSymbol,
        kind: nextKind,
        ...(normalizedChildren === undefined ? {} : { children: normalizedChildren })
    }
}

function getNamedSymbolOverride(node: ts.Node): { name: string; node: ts.Node; kind: SymbolKind } | null {
    if (ts.isTypeAliasDeclaration(node)) {
        return { name: node.name.text, node: node.name, kind: 26 }
    }
    if (ts.isInterfaceDeclaration(node)) {
        return { name: node.name.text, node: node.name, kind: 11 }
    }
    if (ts.isEnumDeclaration(node)) {
        return { name: node.name.text, node: node.name, kind: 10 }
    }
    if (ts.isEnumMember(node) && ts.isIdentifier(node.name)) {
        return { name: node.name.text, node: node.name, kind: 22 }
    }
    return null
}

function symbolKindKey(name: string, position: Position): string {
    return `${name}:${position.line}:${position.character}`
}

function buildScriptSymbolMatch(node: ts.Node, sourceFile: ts.SourceFile, contentStart: number, text: string, uri: string): SymbolMatch | null {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        return buildNamedSymbolMatch(uri, node.name.text, 12, node, node.name, sourceFile, contentStart, text)
    }
    if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
        return buildNamedSymbolMatch(uri, node.name.text, 12, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isMethodDeclaration(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
        return buildNamedSymbolMatch(uri, node.name.text, 6, node, node.name, sourceFile, contentStart, text)
    }
    return null
}

function buildWorkspaceSymbolMatch(node: ts.Node, sourceFile: ts.SourceFile, contentStart: number, text: string, uri: string): SymbolMatch | null {
    if (ts.isTypeAliasDeclaration(node)) {
        return buildNamedSymbolMatch(uri, node.name.text, 26, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isInterfaceDeclaration(node)) {
        return buildNamedSymbolMatch(uri, node.name.text, 11, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isEnumDeclaration(node)) {
        return buildNamedSymbolMatch(uri, node.name.text, 10, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
        return buildNamedSymbolMatch(uri, node.name.text, 5, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        return buildNamedSymbolMatch(uri, node.name.text, 12, node, node.name, sourceFile, contentStart, text)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        return buildNamedSymbolMatch(
            uri,
            node.name.text,
            isFunctionLikeInitializer(node.initializer) ? 12 : 13,
            node,
            node.name,
            sourceFile,
            contentStart,
            text
        )
    }
    if (ts.isMethodDeclaration(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
        return buildNamedSymbolMatch(uri, node.name.text, 6, node, node.name, sourceFile, contentStart, text)
    }
    return null
}
