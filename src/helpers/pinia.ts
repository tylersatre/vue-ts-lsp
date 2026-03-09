import type { SymbolMatch, StoreToRefsBindingMatch } from './types.js'
import { lineCharToOffset } from './position-utils.js'
import {
    findScriptBlockAtOffset,
    findNodeAtOffset,
    collectParseTargets,
    unwrapExpression,
    getCallExpressionName,
    getPropertyNameIdentifier
} from './ast-utils.js'
import { buildNamedSymbolMatch, findLocalDeclarationMatch } from './symbols.js'
import type { Position } from 'vscode-languageserver-protocol'
import ts from 'typescript'

export function findStoreToRefsBindingAtPosition(text: string, position: Position): StoreToRefsBindingMatch | null {
    const documentOffset = lineCharToOffset(text, position)
    const parseTarget = findScriptBlockAtOffset(text, documentOffset) ?? {
        content: text,
        contentStart: 0
    }
    const sourceFile = ts.createSourceFile('component.ts', parseTarget.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const node = findNodeAtOffset(sourceFile, documentOffset - parseTarget.contentStart)
    if (node === null) {
        return null
    }

    let current: ts.Node | undefined = node
    while (current !== undefined) {
        if (ts.isBindingElement(current) && ts.isObjectBindingPattern(current.parent) && ts.isIdentifier(current.name)) {
            const variableDecl = current.parent.parent
            if (!ts.isVariableDeclaration(variableDecl)) {
                return null
            }
            const initializer = unwrapExpression(variableDecl.initializer)
            if (initializer === undefined || !ts.isCallExpression(initializer) || getCallExpressionName(initializer.expression) !== 'storeToRefs') {
                return null
            }

            return {
                localName: current.name.text,
                propertyName: current.propertyName !== undefined && ts.isIdentifier(current.propertyName) ? current.propertyName.text : current.name.text,
                storeFactoryName: resolveStoreFactoryName(sourceFile, initializer.arguments[0])
            }
        }
        current = current.parent
    }

    return null
}

export function findPiniaStoreReturnedSymbol(text: string, uri: string, storeFactoryName: string, propertyName: string): SymbolMatch | null {
    for (const target of collectParseTargets(uri, text)) {
        const sourceFile = ts.createSourceFile(target.filename, target.content, ts.ScriptTarget.Latest, true, target.scriptKind)
        let match: SymbolMatch | null = null

        const visit = (node: ts.Node): void => {
            if (match !== null) {
                return
            }

            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === storeFactoryName) {
                match = findReturnedSymbolForStoreDeclaration(node.initializer, propertyName, sourceFile, target.contentStart, text, uri)
                if (match !== null) {
                    return
                }
            }

            if (ts.isFunctionDeclaration(node) && node.name?.text === storeFactoryName) {
                match = findReturnedSymbolForFunctionLike(node, propertyName, sourceFile, target.contentStart, text, uri)
                if (match !== null) {
                    return
                }
            }

            ts.forEachChild(node, visit)
        }

        visit(sourceFile)
        if (match !== null) {
            return match
        }
    }

    return null
}

function resolveStoreFactoryName(sourceFile: ts.SourceFile, expression: ts.Expression | undefined): string | null {
    const unwrapped = unwrapExpression(expression)
    if (unwrapped === undefined) {
        return null
    }
    if (ts.isCallExpression(unwrapped)) {
        return getCallExpressionName(unwrapped.expression)
    }
    if (!ts.isIdentifier(unwrapped)) {
        return null
    }

    let match: string | null = null
    const visit = (node: ts.Node): void => {
        if (match !== null) {
            return
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === unwrapped.text) {
            const initializer = unwrapExpression(node.initializer)
            if (initializer !== undefined && ts.isCallExpression(initializer)) {
                match = getCallExpressionName(initializer.expression)
            }
            return
        }
        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return match
}

function findReturnedSymbolForStoreDeclaration(
    initializer: ts.Expression | undefined,
    propertyName: string,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    const unwrapped = unwrapExpression(initializer)
    if (unwrapped === undefined) {
        return null
    }

    if (ts.isCallExpression(unwrapped) && getCallExpressionName(unwrapped.expression) === 'defineStore') {
        const storeDefinition = unwrapExpression((unwrapped.arguments[1] ?? unwrapped.arguments[0]) as ts.Expression | undefined)
        if (storeDefinition === undefined) {
            return null
        }
        if (ts.isArrowFunction(storeDefinition) || ts.isFunctionExpression(storeDefinition)) {
            return findReturnedSymbolForFunctionLike(storeDefinition, propertyName, sourceFile, contentStart, text, uri)
        }
        if (ts.isObjectLiteralExpression(storeDefinition)) {
            return findReturnedSymbolForOptionsStore(storeDefinition, propertyName, sourceFile, contentStart, text, uri)
        }
    }

    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        return findReturnedSymbolForFunctionLike(unwrapped, propertyName, sourceFile, contentStart, text, uri)
    }

    return null
}

function findReturnedSymbolForFunctionLike(
    functionLike: ts.FunctionLikeDeclaration,
    propertyName: string,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    const body = functionLike.body
    if (body === undefined) {
        return null
    }

    if (ts.isObjectLiteralExpression(body)) {
        return resolveReturnedPropertyMatch(body, body, propertyName, sourceFile, contentStart, text, uri)
    }

    let match: SymbolMatch | null = null
    const visit = (node: ts.Node): void => {
        if (match !== null) {
            return
        }
        if (node !== body && ts.isFunctionLike(node)) {
            return
        }
        if (ts.isReturnStatement(node) && node.expression !== undefined) {
            const returned = unwrapExpression(node.expression)
            if (ts.isObjectLiteralExpression(returned)) {
                match = resolveReturnedPropertyMatch(returned, body, propertyName, sourceFile, contentStart, text, uri)
                return
            }
        }
        ts.forEachChild(node, visit)
    }

    visit(body)
    return match
}

function resolveReturnedPropertyMatch(
    objectLiteral: ts.ObjectLiteralExpression,
    scopeNode: ts.Node,
    propertyName: string,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    for (const property of objectLiteral.properties) {
        const propertyIdentifier = getPropertyNameIdentifier(property.name)
        if (propertyIdentifier === null || propertyIdentifier.text !== propertyName) {
            continue
        }

        if (ts.isShorthandPropertyAssignment(property)) {
            return (
                findLocalDeclarationMatch(scopeNode, property.name.text, sourceFile, contentStart, text, uri) ??
                buildNamedSymbolMatch(uri, property.name.text, 13, property, property.name, sourceFile, contentStart, text)
            )
        }

        if (ts.isPropertyAssignment(property)) {
            const initializer = unwrapExpression(property.initializer)
            if (ts.isIdentifier(initializer)) {
                const localMatch = findLocalDeclarationMatch(scopeNode, initializer.text, sourceFile, contentStart, text, uri)
                if (localMatch !== null) {
                    return localMatch
                }
            }

            return buildNamedSymbolMatch(uri, propertyIdentifier.text, 13, property, propertyIdentifier, sourceFile, contentStart, text)
        }

        if (ts.isMethodDeclaration(property)) {
            return buildNamedSymbolMatch(uri, propertyIdentifier.text, 6, property, propertyIdentifier, sourceFile, contentStart, text)
        }
    }

    return null
}

function findReturnedSymbolForOptionsStore(
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    for (const property of objectLiteral.properties) {
        const propertyIdentifier = getPropertyNameIdentifier(property.name)
        if (propertyIdentifier === null) {
            continue
        }

        if (propertyIdentifier.text === 'state' && ts.isPropertyAssignment(property)) {
            const stateInitializer = unwrapExpression(property.initializer)
            if (ts.isArrowFunction(stateInitializer) || ts.isFunctionExpression(stateInitializer)) {
                const stateObject = ts.isObjectLiteralExpression(stateInitializer.body)
                    ? stateInitializer.body
                    : findReturnedObjectLiteral(stateInitializer.body)
                if (stateObject !== null) {
                    const stateMatch = findObjectLiteralPropertyMatch(stateObject, propertyName, 13, sourceFile, contentStart, text, uri)
                    if (stateMatch !== null) {
                        return stateMatch
                    }
                }
            }
        }

        if (propertyIdentifier.text === 'getters' && ts.isPropertyAssignment(property)) {
            const getters = unwrapExpression(property.initializer)
            if (ts.isObjectLiteralExpression(getters)) {
                const getterMatch = findObjectLiteralPropertyMatch(getters, propertyName, 6, sourceFile, contentStart, text, uri)
                if (getterMatch !== null) {
                    return getterMatch
                }
            }
        }
    }

    return null
}

function findObjectLiteralPropertyMatch(
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
    kind: number,
    sourceFile: ts.SourceFile,
    contentStart: number,
    text: string,
    uri: string
): SymbolMatch | null {
    for (const property of objectLiteral.properties) {
        const identifier = getPropertyNameIdentifier(property.name)
        if (identifier === null || identifier.text !== propertyName) {
            continue
        }
        return buildNamedSymbolMatch(uri, identifier.text, kind, property, identifier, sourceFile, contentStart, text)
    }
    return null
}

function findReturnedObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | null {
    if (!ts.isBlock(node)) {
        return null
    }

    for (const statement of node.statements) {
        if (ts.isReturnStatement(statement) && statement.expression !== undefined) {
            const returned = unwrapExpression(statement.expression)
            if (ts.isObjectLiteralExpression(returned)) {
                return returned
            }
        }
    }

    return null
}
