import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export function findScriptBlockAtOffset(text: string, offset: number): { content: string; contentStart: number } | null {
    const scriptTagPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
    let match: RegExpExecArray | null

    while ((match = scriptTagPattern.exec(text)) !== null) {
        const fullMatch = match[0]
        const content = match[1] ?? ''
        const openTagEnd = fullMatch.indexOf('>')
        const contentStart = match.index + openTagEnd + 1
        const contentEnd = contentStart + content.length
        if (offset >= contentStart && offset <= contentEnd) {
            return { content, contentStart }
        }
    }

    return null
}

export function findFirstScriptBlock(text: string): { content: string; contentStart: number } | null {
    const scriptOpen = text.indexOf('<script')
    if (scriptOpen < 0) {
        return null
    }
    const scriptTagEnd = text.indexOf('>', scriptOpen)
    if (scriptTagEnd < 0) {
        return null
    }
    const scriptClose = text.indexOf('</script>', scriptTagEnd)
    if (scriptClose < 0) {
        return null
    }
    return {
        content: text.slice(scriptTagEnd + 1, scriptClose),
        contentStart: scriptTagEnd + 1
    }
}

export function findNodeAtOffset(root: ts.Node, offset: number): ts.Node | null {
    let best: ts.Node | null = null

    const visit = (node: ts.Node): void => {
        if (offset < node.getFullStart() || offset > node.getEnd()) {
            return
        }
        best = node
        ts.forEachChild(node, visit)
    }

    visit(root)
    return best
}

export function collectParseTargets(
    uri: string,
    text: string
): Array<{
    filename: string
    content: string
    contentStart: number
    scriptKind: ts.ScriptKind
}> {
    if (getExtension(uri) !== '.vue') {
        return [
            {
                filename: `document${getExtension(uri) || '.ts'}`,
                content: text,
                contentStart: 0,
                scriptKind: scriptKindForExtension(getExtension(uri))
            }
        ]
    }

    const targets: Array<{
        filename: string
        content: string
        contentStart: number
        scriptKind: ts.ScriptKind
    }> = []
    const scriptTagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
    let match: RegExpExecArray | null
    while ((match = scriptTagPattern.exec(text)) !== null) {
        const attrs = match[1] ?? ''
        const fullMatch = match[0]
        const content = match[2] ?? ''
        const openTagEnd = fullMatch.indexOf('>')
        targets.push({
            filename: 'component.ts',
            content,
            contentStart: match.index + openTagEnd + 1,
            scriptKind: scriptKindForVueAttrs(attrs)
        })
    }
    return targets
}

export function scriptKindForVueAttrs(attrs: string): ts.ScriptKind {
    const lowered = attrs.toLowerCase()
    if (lowered.includes('lang="tsx"') || lowered.includes("lang='tsx'")) {
        return ts.ScriptKind.TSX
    }
    if (lowered.includes('lang="jsx"') || lowered.includes("lang='jsx'")) {
        return ts.ScriptKind.JSX
    }
    if (lowered.includes('lang="js"') || lowered.includes("lang='js'")) {
        return ts.ScriptKind.JS
    }
    return ts.ScriptKind.TS
}

export function scriptKindForExtension(ext: string): ts.ScriptKind {
    switch (ext.toLowerCase()) {
        case '.tsx':
            return ts.ScriptKind.TSX
        case '.jsx':
            return ts.ScriptKind.JSX
        case '.js':
        case '.mjs':
        case '.cjs':
            return ts.ScriptKind.JS
        default:
            return ts.ScriptKind.TS
    }
}

export function getExtension(uri: string): string {
    try {
        return path.extname(fileURLToPath(uri))
    } catch {
        const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri
        return path.extname(withoutQuery)
    }
}

export function isFunctionLikeInitializer(initializer: ts.Expression | undefined): boolean {
    return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
}

export function unwrapExpression<T extends ts.Expression | undefined>(expression: T): T {
    let current = expression
    while (current !== undefined && ts.isParenthesizedExpression(current)) {
        current = current.expression as T
    }
    return current
}

export function getCallExpressionName(expression: ts.Expression): string | null {
    const unwrapped = unwrapExpression(expression)
    if (unwrapped === undefined) {
        return null
    }
    if (ts.isIdentifier(unwrapped)) {
        return unwrapped.text
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
        return unwrapped.name.text
    }
    return null
}

export function getModuleSpecifier(importDeclaration: ts.ImportDeclaration): string | null {
    return ts.isStringLiteral(importDeclaration.moduleSpecifier) ? importDeclaration.moduleSpecifier.text : null
}

export function getPropertyNameIdentifier(name: ts.PropertyName | undefined): ts.Identifier | null {
    if (name === undefined) {
        return null
    }
    if (ts.isIdentifier(name)) {
        return name
    }
    return null
}

export function hasExportModifier(node: ts.Node): boolean {
    return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}
