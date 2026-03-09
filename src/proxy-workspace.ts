import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import type { PathAliasConfig } from './proxy-types.js'
import { uriToFilePath } from './proxy-utils.js'
import { collectImportedModuleSpecifiers } from './helpers/imports.js'
import { loadWorkspaceConfig } from './config.js'
import * as logger from './logger.js'

export function getWorkspaceRootPathFromInitParams(params: InitializeParams | null): string | null {
    const rootUri = params?.rootUri ?? params?.workspaceFolders?.[0]?.uri ?? null
    return rootUri === null ? null : uriToFilePath(rootUri)
}

export function getWorkspaceRootPath(ctx: ProxyContext): string | null {
    return getWorkspaceRootPathFromInitParams(ctx.savedInitParams)
}

export function isIgnoredWorkspaceDirectory(ctx: ProxyContext, rootPath: string, dirPath: string): boolean {
    if (ctx.workspaceConfig.ignoreDirectories.length === 0) {
        return false
    }

    const relativePath = path.relative(rootPath, dirPath)
    if (relativePath.length === 0 || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false
    }

    const normalizedRelativePath = relativePath.replace(/\\/g, '/')
    return ctx.workspaceConfig.ignoreDirectories.includes(normalizedRelativePath)
}

export function applyWorkspaceConfigFromInitParams(ctx: ProxyContext, params: InitializeParams): void {
    const workspaceRootPath = getWorkspaceRootPathFromInitParams(params)
    ctx.workspaceConfig = { ignoreDirectories: [], logLevel: null }
    if (workspaceRootPath === null) {
        logger.debug('proxy', 'workspace config skipped reason=no-workspace-root')
        return
    }

    const result = loadWorkspaceConfig(workspaceRootPath)
    ctx.workspaceConfig = result.config
    for (const warning of result.warnings) {
        logger.warn('proxy', `workspace config ${warning}`)
    }
    if (ctx.crashOptions?.cliLogLevel == null && result.config.logLevel !== null) {
        logger.setLogLevel(result.config.logLevel)
    }

    logger.debug(
        'proxy',
        `workspace config path=${result.path ?? '-'} ignoreDirectories=${ctx.workspaceConfig.ignoreDirectories.length} logLevel=${ctx.workspaceConfig.logLevel ?? '-'} cliOverride=${ctx.crashOptions?.cliLogLevel ?? '-'}`
    )
}

export function loadPathAliasConfigs(ctx: ProxyContext, rootPath: string): PathAliasConfig[] {
    const cached = ctx.pathAliasConfigCache.get(rootPath)
    if (cached !== undefined) {
        return cached
    }

    const configs: PathAliasConfig[] = []
    for (const configName of ['tsconfig.json', 'jsconfig.json']) {
        const configPath = path.join(rootPath, configName)
        if (!fs.existsSync(configPath)) {
            continue
        }

        const readResult = ts.readConfigFile(configPath, ts.sys.readFile)
        if (readResult.error !== undefined || readResult.config === undefined) {
            continue
        }

        const compilerOptions = (readResult.config.compilerOptions ?? {}) as {
            baseUrl?: string
            paths?: Record<string, string[]>
        }
        if (compilerOptions.baseUrl === undefined && compilerOptions.paths === undefined) {
            continue
        }

        configs.push({
            baseUrl: path.resolve(path.dirname(configPath), compilerOptions.baseUrl ?? '.'),
            paths: compilerOptions.paths ?? {}
        })
    }

    ctx.pathAliasConfigCache.set(rootPath, configs)
    return configs
}

export function resolveFileCandidate(basePath: string): string | null {
    const candidates = new Set<string>([
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.jsx`,
        `${basePath}.d.ts`,
        `${basePath}.vue`,
        path.join(basePath, 'index.ts'),
        path.join(basePath, 'index.tsx'),
        path.join(basePath, 'index.js'),
        path.join(basePath, 'index.jsx'),
        path.join(basePath, 'index.d.ts'),
        path.join(basePath, 'index.vue')
    ])

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate
        }
    }

    return null
}

export function applyPathPattern(pattern: string, target: string, specifier: string): string | null {
    const wildcardIndex = pattern.indexOf('*')
    if (wildcardIndex < 0) {
        return pattern === specifier ? target : null
    }

    const prefix = pattern.slice(0, wildcardIndex)
    const suffix = pattern.slice(wildcardIndex + 1)
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
        return null
    }

    const middle = specifier.slice(prefix.length, specifier.length - suffix.length)
    return target.replace('*', middle)
}

export function resolveWorkspaceModuleSpecifier(ctx: ProxyContext, requestUri: string, moduleSpecifier: string): string | null {
    const requestPath = uriToFilePath(requestUri)
    if (requestPath === null) {
        return null
    }

    if (moduleSpecifier.startsWith('.')) {
        return resolveFileCandidate(path.resolve(path.dirname(requestPath), moduleSpecifier))
    }

    if (path.isAbsolute(moduleSpecifier)) {
        return resolveFileCandidate(moduleSpecifier)
    }

    const workspaceRootPath = getWorkspaceRootPath(ctx)
    if (workspaceRootPath === null) {
        return null
    }

    for (const config of loadPathAliasConfigs(ctx, workspaceRootPath)) {
        for (const [pattern, targets] of Object.entries(config.paths)) {
            for (const target of targets) {
                const mapped = applyPathPattern(pattern, target, moduleSpecifier)
                if (mapped === null) {
                    continue
                }
                const resolved = resolveFileCandidate(path.resolve(config.baseUrl, mapped))
                if (resolved !== null) {
                    return resolved
                }
            }
        }
    }

    return null
}

export function listWorkspaceSourceFiles(ctx: ProxyContext, rootPath: string): string[] {
    const files: string[] = []
    const stack = [rootPath]
    const skippedDirs = new Set(['.git', '.cache', '.idea', '.next', '.nuxt', '.turbo', '.vite', 'coverage', 'dist', 'node_modules', 'tmp'])

    while (stack.length > 0) {
        const current = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(current, { withFileTypes: true })
        } catch {
            continue
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name)
            if (entry.isDirectory()) {
                if (!skippedDirs.has(entry.name) && !isIgnoredWorkspaceDirectory(ctx, rootPath, fullPath)) {
                    stack.push(fullPath)
                }
                continue
            }

            if (!entry.isFile()) {
                continue
            }

            if (/\.(?:vue|[cm]?[jt]sx?)$/i.test(entry.name)) {
                files.push(fullPath)
            }
        }
    }

    return files
}

export function getDocumentText(ctx: ProxyContext, uri: string): string | null {
    const doc = ctx.documentStore.get(uri)
    if (doc !== undefined) {
        return doc.content
    }

    const filePath = uriToFilePath(uri)
    if (filePath === null) {
        return null
    }

    try {
        return fs.readFileSync(filePath, 'utf8')
    } catch {
        return null
    }
}

export function collectWorkspaceImporterUris(ctx: ProxyContext, requestUri: string): string[] {
    const workspaceRootPath = getWorkspaceRootPath(ctx)
    const requestPath = uriToFilePath(requestUri)
    if (workspaceRootPath === null || requestPath === null) {
        return []
    }

    const importerUris: string[] = []
    const seen = new Set<string>()
    for (const filePath of listWorkspaceSourceFiles(ctx, workspaceRootPath)) {
        const uri = pathToFileURL(filePath).href
        if (uri === requestUri) {
            continue
        }

        const text = getDocumentText(ctx, uri)
        if (text === null) {
            continue
        }

        const importsEditedModule = collectImportedModuleSpecifiers(uri, text).some(
            (moduleSpecifier) => resolveWorkspaceModuleSpecifier(ctx, uri, moduleSpecifier) === requestPath
        )
        if (!importsEditedModule) {
            continue
        }

        if (seen.has(uri)) {
            continue
        }
        seen.add(uri)
        importerUris.push(uri)
    }

    return importerUris
}
