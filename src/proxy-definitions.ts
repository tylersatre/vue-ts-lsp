import { pathToFileURL } from 'node:url'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import type { Position, Range } from 'vscode-languageserver-protocol'
import type { ProxyContext } from './proxy-context.js'
import { VUE_DEFINITION_TIMEOUT_MS, VUE_DEFINITION_RETRY_DELAY_MS, VUE_PROJECT_WARMUP_DELAY_MS, DownstreamRequestTimeoutError } from './proxy-types.js'
import { isVueUri, isScriptLikeUri, isPosition, uriToFilePath } from './proxy-utils.js'
import { sendDownstreamRequest, executeTsserverCommand, maybeRecoverVtslsAfterTimeout } from './proxy-communication.js'
import { getDocumentText, resolveWorkspaceModuleSpecifier } from './proxy-workspace.js'
import { classifyDefinitionResult, normalizeDefinitionResult, preferDefinitionResult } from './helpers/definitions.js'
import { findVueImportAtPosition, normalizeVueImportPosition, findImportAtPosition, normalizeImportPosition, findImportByLocalName } from './helpers/imports.js'
import { createDefinitionProbe, isInternalProbeUri } from './helpers/probes.js'
import { findStoreToRefsBindingAtPosition, findPiniaStoreReturnedSymbol } from './helpers/pinia.js'
import { findVueTemplateComponentAtPosition, normalizeVueTemplateExpressionPosition } from './helpers/vue-template.js'
import { rewriteExternalDefinitionResult } from './definition-mirrors.js'
import * as logger from './logger.js'

export function offsetToPositionForRange(text: string, offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, text.length))
    const prior = text.slice(0, clamped).split('\n')
    return {
        line: prior.length - 1,
        character: prior[prior.length - 1]!.length
    }
}

export function firstPositionInFile(ctx: ProxyContext, uri: string): Range {
    const text = getDocumentText(ctx, uri) ?? ''
    const firstNonWhitespace = text.search(/\S/)
    const offset = firstNonWhitespace >= 0 ? firstNonWhitespace : 0
    const start = { line: 0, character: 0 }
    const end = offsetToPositionForRange(text, offset)
    return { start, end }
}

export function buildNormalizedVueTemplateParams(
    ctx: ProxyContext,
    requestUri: string,
    params: unknown
): { params: unknown; normalizedPosition: Position } | null {
    if (params === null || typeof params !== 'object' || !('position' in params) || !isPosition((params as { position: unknown }).position)) {
        return null
    }

    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        return null
    }

    const normalizedPosition = normalizeVueTemplateExpressionPosition(text, (params as { position: Position }).position)
    if (
        normalizedPosition === null ||
        (normalizedPosition.line === (params as { position: Position }).position.line &&
            normalizedPosition.character === (params as { position: Position }).position.character)
    ) {
        return null
    }

    return {
        params: {
            ...(params as Record<string, unknown>),
            position: normalizedPosition
        },
        normalizedPosition
    }
}

export function isVueShimUri(uri: string): boolean {
    const decoded = decodeURIComponent(uri)
    return decoded.endsWith('vue-shims.d.ts') || decoded.endsWith('shims-vue.d.ts')
}

export function hasVueShimDefinition(result: unknown): boolean {
    const normalized = normalizeDefinitionResult(result)
    const values = Array.isArray(normalized) ? normalized : normalized === null ? [] : [normalized]
    return values.some(
        (value) =>
            value !== null &&
            typeof value === 'object' &&
            'uri' in value &&
            typeof (value as { uri: unknown }).uri === 'string' &&
            isVueShimUri((value as { uri: string }).uri)
    )
}

export function requestTemplateComponentDefinitionFallback(ctx: ProxyContext, requestUri: string, params: unknown): unknown | null {
    if (params === null || typeof params !== 'object' || !('position' in params) || !isPosition((params as { position: unknown }).position)) {
        return null
    }

    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        return null
    }

    const componentName = findVueTemplateComponentAtPosition(text, (params as { position: Position }).position)
    if (componentName === null) {
        return null
    }

    const importTarget = findImportByLocalName(text, componentName)
    if (importTarget === null) {
        return null
    }

    const resolvedPath = resolveWorkspaceModuleSpecifier(ctx, requestUri, importTarget.moduleSpecifier)
    if (resolvedPath === null) {
        return null
    }

    const targetUri = pathToFileURL(resolvedPath).href
    logger.debug('proxy', `textDocument/definition component fallback uri=${requestUri} component=${componentName} target=${targetUri}`)
    return [
        {
            uri: targetUri,
            range: firstPositionInFile(ctx, targetUri)
        }
    ]
}

export function maybePrimeDocument(ctx: ProxyContext, uri: string): void {
    const filePath = uriToFilePath(uri)
    if (filePath === null || isInternalProbeUri(uri)) {
        return
    }

    if (isVueUri(uri)) {
        setTimeout(() => {
            void executeTsserverCommand(ctx, '_vue:projectInfo', { file: filePath, needFileNameList: false }, `textDocument/didOpen ${uri} vue warm-up`, {
                background: true
            })
        }, VUE_PROJECT_WARMUP_DELAY_MS)
    }
}

export function resolveImportTargetForRequest(requestUri: string, text: string, position: Position) {
    if (isVueUri(requestUri)) {
        return {
            importTarget: findVueImportAtPosition(text, position),
            normalizedPosition: normalizeVueImportPosition(text, position)
        }
    }

    return {
        importTarget: findImportAtPosition(text, position),
        normalizedPosition: normalizeImportPosition(text, position)
    }
}

export function finalizeDefinitionResult(ctx: ProxyContext, requestUri: string | null, result: unknown): unknown {
    const preferred = requestUri === null ? result : preferDefinitionResult(requestUri, result, ctx.savedInitParams?.rootUri ?? null)
    const rewritten = rewriteExternalDefinitionResult(preferred)
    if (rewritten.rewrites.length > 0) {
        const sample = rewritten.rewrites[0]!
        logger.debug(
            'proxy',
            `textDocument/definition mirror uri=${requestUri ?? '-'} rewritten=${rewritten.rewrites.length} source=${sample.sourceUri} mirror=${sample.mirrorUri}`
        )
    }
    return rewritten.result
}

export async function tryDefinitionRequest(
    ctx: ProxyContext,
    target: 'vtsls' | 'vue_ls',
    params: unknown,
    timeoutMs = Math.min(ctx.requestTimeoutMs, VUE_DEFINITION_TIMEOUT_MS)
): Promise<{ result: unknown; timedOut: boolean }> {
    try {
        const result = await sendDownstreamRequest(ctx, target, 'textDocument/definition', params, {
            retryOnTimeout: false,
            timeoutMs
        })
        return { result, timedOut: false }
    } catch (err: unknown) {
        if (err instanceof DownstreamRequestTimeoutError) {
            return { result: null, timedOut: true }
        }
        throw err
    }
}

export async function requestVueLsDefinitionFallback(ctx: ProxyContext, requestUri: string, params: unknown, reason: string): Promise<unknown | null> {
    const attempt = await tryDefinitionRequest(ctx, 'vue_ls', params)
    if (attempt.timedOut) {
        logger.warn('proxy', `textDocument/definition vue_ls timeout uri=${requestUri} reason=${reason}`)
        return null
    }

    const result = normalizeDefinitionResult(attempt.result)
    if (hasVueShimDefinition(result)) {
        const componentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
        if (componentFallback !== null) {
            return componentFallback
        }
    }

    const classification = classifyDefinitionResult(requestUri, result, ctx.savedInitParams?.rootUri ?? null)
    logger.debug(
        'proxy',
        `textDocument/definition vue_ls fallback uri=${requestUri} reason=${reason} classification=${classification.kind} count=${classification.count}`
    )
    return classification.count === 0 ? null : finalizeDefinitionResult(ctx, requestUri, result)
}

export async function requestImportDefinitionProbe(ctx: ProxyContext, requestUri: string, params: unknown): Promise<unknown | null> {
    if (params === null || typeof params !== 'object' || !('position' in params) || !isPosition((params as { position: unknown }).position)) {
        return null
    }

    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        logger.debug('proxy', `textDocument/definition probe skipped uri=${requestUri} reason=no-document-text`)
        return null
    }

    const { importTarget } = resolveImportTargetForRequest(requestUri, text, (params as { position: Position }).position)
    if (importTarget === null) {
        logger.debug('proxy', `textDocument/definition probe skipped uri=${requestUri} reason=not-an-import`)
        return null
    }

    const probe = createDefinitionProbe(requestUri, importTarget)
    logger.debug(
        'proxy',
        `textDocument/definition probe open uri=${requestUri} probe=${probe.uri} module=${importTarget.moduleSpecifier} import=${importTarget.localName}`
    )

    ctx.currentVtsls.sendNotification('textDocument/didOpen', {
        textDocument: {
            uri: probe.uri,
            languageId: 'typescript',
            version: 1,
            text: probe.text
        }
    })

    try {
        const probeResult = normalizeDefinitionResult(
            await sendDownstreamRequest(ctx, 'vtsls', 'textDocument/definition', {
                textDocument: { uri: probe.uri },
                position: probe.position
            })
        )
        const probeClassification = classifyDefinitionResult(requestUri, probeResult, ctx.savedInitParams?.rootUri ?? null)
        logger.debug('proxy', `textDocument/definition probe uri=${requestUri} classification=${probeClassification.kind} count=${probeClassification.count}`)
        return probeClassification.kind === 'empty' || probeClassification.kind === 'self' ? null : finalizeDefinitionResult(ctx, requestUri, probeResult)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/definition probe ${requestUri} ERROR: ${msg}`)
        return null
    } finally {
        ctx.currentVtsls.sendNotification('textDocument/didClose', {
            textDocument: { uri: probe.uri }
        })
    }
}

export async function requestImportSourceDefinition(ctx: ProxyContext, requestUri: string, params: unknown): Promise<unknown | null> {
    if (params === null || typeof params !== 'object' || !('position' in params) || !isPosition((params as { position: unknown }).position)) {
        return null
    }

    const originalPosition = (params as { position: Position }).position
    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        logger.debug('proxy', `textDocument/definition sourceDefinition skipped uri=${requestUri} reason=no-document-text`)
        return null
    }

    const { importTarget, normalizedPosition } = resolveImportTargetForRequest(requestUri, text, originalPosition)
    if (importTarget === null || normalizedPosition === null) {
        logger.debug('proxy', `textDocument/definition sourceDefinition skipped uri=${requestUri} reason=not-an-import`)
        return null
    }

    const normalizedSuffix =
        normalizedPosition.line === originalPosition.line && normalizedPosition.character === originalPosition.character
            ? ''
            : ` normalized=${normalizedPosition.line}:${normalizedPosition.character}`
    logger.debug(
        'proxy',
        `textDocument/definition sourceDefinition uri=${requestUri} module=${importTarget.moduleSpecifier} import=${importTarget.localName} position=${originalPosition.line}:${originalPosition.character}${normalizedSuffix}`
    )

    try {
        const sourceResult = normalizeDefinitionResult(
            await sendDownstreamRequest(ctx, 'vtsls', 'workspace/executeCommand', {
                command: 'typescript.goToSourceDefinition',
                arguments: [requestUri, normalizedPosition]
            })
        )
        const sourceClassification = classifyDefinitionResult(requestUri, sourceResult, ctx.savedInitParams?.rootUri ?? null)
        logger.debug(
            'proxy',
            `textDocument/definition sourceDefinition uri=${requestUri} classification=${sourceClassification.kind} count=${sourceClassification.count}`
        )
        return sourceClassification.kind === 'empty' || sourceClassification.kind === 'self' ? null : finalizeDefinitionResult(ctx, requestUri, sourceResult)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/definition sourceDefinition ${requestUri} ERROR: ${msg}`)
        return null
    }
}

export function requestScriptStoreToRefsDefinitionFallback(ctx: ProxyContext, requestUri: string, params: unknown): unknown | null {
    if (params === null || typeof params !== 'object' || !('position' in params) || !isPosition((params as { position: unknown }).position)) {
        return null
    }

    const text = getDocumentText(ctx, requestUri)
    if (text === null) {
        return null
    }

    const binding = findStoreToRefsBindingAtPosition(text, (params as { position: Position }).position)
    if (binding === null || binding.storeFactoryName === null) {
        return null
    }

    const importTarget = findImportByLocalName(text, binding.storeFactoryName)
    if (importTarget === null) {
        logger.debug(
            'proxy',
            `textDocument/definition storeToRefs fallback skipped uri=${requestUri} reason=missing-store-import binding=${binding.propertyName}`
        )
        return null
    }

    const resolvedPath = resolveWorkspaceModuleSpecifier(ctx, requestUri, importTarget.moduleSpecifier)
    if (resolvedPath === null) {
        logger.debug(
            'proxy',
            `textDocument/definition storeToRefs fallback skipped uri=${requestUri} reason=unresolved-store-module module=${importTarget.moduleSpecifier}`
        )
        return null
    }

    const targetUri = pathToFileURL(resolvedPath).href
    const targetText = getDocumentText(ctx, targetUri)
    if (targetText === null) {
        return null
    }

    const symbol = findPiniaStoreReturnedSymbol(targetText, targetUri, binding.storeFactoryName, binding.propertyName)
    if (symbol === null) {
        logger.debug(
            'proxy',
            `textDocument/definition storeToRefs fallback skipped uri=${requestUri} reason=no-store-symbol property=${binding.propertyName} store=${binding.storeFactoryName}`
        )
        return null
    }

    logger.debug(
        'proxy',
        `textDocument/definition storeToRefs fallback uri=${requestUri} property=${binding.propertyName} store=${binding.storeFactoryName} target=${targetUri}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`
    )
    return [
        {
            uri: symbol.uri,
            range: symbol.selectionRange
        }
    ]
}

export async function requestRecoveredVueDefinition(
    ctx: ProxyContext,
    requestUri: string,
    params: unknown,
    normalizedTemplateParams: {
        params: unknown
        normalizedPosition: Position
    } | null
): Promise<unknown | null> {
    const recoveredAttempt = await tryDefinitionRequest(ctx, 'vtsls', params)
    if (!recoveredAttempt.timedOut) {
        const recoveredResult = normalizeDefinitionResult(recoveredAttempt.result)
        const recoveredClassification = classifyDefinitionResult(requestUri, recoveredResult, ctx.savedInitParams?.rootUri ?? null)
        logger.debug(
            'proxy',
            `textDocument/definition recovered uri=${requestUri} classification=${recoveredClassification.kind} count=${recoveredClassification.count}`
        )

        if (hasVueShimDefinition(recoveredResult)) {
            const componentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
            if (componentFallback !== null) {
                return componentFallback
            }
        }

        if (recoveredClassification.kind !== 'empty' && recoveredClassification.kind !== 'self') {
            return finalizeDefinitionResult(ctx, requestUri, recoveredResult)
        }

        if (normalizedTemplateParams !== null) {
            const normalizedResult = normalizeDefinitionResult((await tryDefinitionRequest(ctx, 'vtsls', normalizedTemplateParams.params)).result)
            const normalizedClassification = classifyDefinitionResult(requestUri, normalizedResult, ctx.savedInitParams?.rootUri ?? null)
            logger.debug(
                'proxy',
                `textDocument/definition recovered-template-normalized uri=${requestUri} position=${normalizedTemplateParams.normalizedPosition.line}:${normalizedTemplateParams.normalizedPosition.character} classification=${normalizedClassification.kind} count=${normalizedClassification.count}`
            )
            if (normalizedClassification.kind !== 'empty' && normalizedClassification.kind !== 'self') {
                return finalizeDefinitionResult(ctx, requestUri, normalizedResult)
            }
        }
    } else {
        logger.warn('proxy', `textDocument/definition recovered timeout uri=${requestUri}`)
    }

    const sourceResult = await requestImportSourceDefinition(ctx, requestUri, params)
    if (sourceResult !== null) {
        return sourceResult
    }

    const probeResult = await requestImportDefinitionProbe(ctx, requestUri, params)
    if (probeResult !== null) {
        return probeResult
    }

    const storeToRefsFallback = requestScriptStoreToRefsDefinitionFallback(ctx, requestUri, params)
    if (storeToRefsFallback !== null) {
        return storeToRefsFallback
    }

    return null
}

export async function requestWithVueDefinitionRetry(
    ctx: ProxyContext,
    _conn: MessageConnection,
    params: unknown,
    target: 'vtsls' | 'vue_ls',
    requestUri: string | null
): Promise<unknown> {
    if (target !== 'vtsls' || requestUri === null || !isVueUri(requestUri)) {
        const initialResult = normalizeDefinitionResult(await sendDownstreamRequest(ctx, target, 'textDocument/definition', params))
        if (target === 'vtsls' && requestUri !== null && isScriptLikeUri(requestUri)) {
            const classification = classifyDefinitionResult(requestUri, initialResult, ctx.savedInitParams?.rootUri ?? null)
            logger.debug('proxy', `textDocument/definition initial uri=${requestUri} classification=${classification.kind} count=${classification.count}`)
            if (classification.kind === 'empty' || classification.kind === 'self') {
                const sourceResult = await requestImportSourceDefinition(ctx, requestUri, params)
                if (sourceResult !== null) {
                    return sourceResult
                }
                const probeResult = await requestImportDefinitionProbe(ctx, requestUri, params)
                if (probeResult !== null) {
                    return probeResult
                }
            }
        }
        return finalizeDefinitionResult(ctx, requestUri, initialResult)
    }

    const normalizedTemplateParams = buildNormalizedVueTemplateParams(ctx, requestUri, params)
    const vueFallbackParams = normalizedTemplateParams?.params ?? params
    const initialAttempt = await tryDefinitionRequest(ctx, 'vtsls', params)
    const initialResult = normalizeDefinitionResult(initialAttempt.result)

    if (initialAttempt.timedOut) {
        logger.warn('proxy', `textDocument/definition initial timeout uri=${requestUri} fallback=vue_ls`)
        const recoveryPromise = maybeRecoverVtslsAfterTimeout(ctx, 'textDocument/definition')
        const vueFallback = await requestVueLsDefinitionFallback(ctx, requestUri, vueFallbackParams, 'initial-timeout')
        if (vueFallback !== null) {
            return vueFallback
        }
        const componentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
        if (componentFallback !== null) {
            return componentFallback
        }
        if (recoveryPromise !== null) {
            await recoveryPromise
            const recoveredResult = await requestRecoveredVueDefinition(ctx, requestUri, params, normalizedTemplateParams)
            if (recoveredResult !== null) {
                return recoveredResult
            }
        }
        return finalizeDefinitionResult(ctx, requestUri, initialResult)
    }

    const classification = classifyDefinitionResult(requestUri, initialResult, ctx.savedInitParams?.rootUri ?? null)
    logger.debug('proxy', `textDocument/definition initial uri=${requestUri} classification=${classification.kind} count=${classification.count}`)

    if (hasVueShimDefinition(initialResult)) {
        const componentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
        if (componentFallback !== null) {
            return componentFallback
        }
    }

    if (classification.kind !== 'empty' && classification.kind !== 'self') {
        return finalizeDefinitionResult(ctx, requestUri, initialResult)
    }

    if (normalizedTemplateParams !== null) {
        try {
            const normalizedResult = normalizeDefinitionResult((await tryDefinitionRequest(ctx, target, normalizedTemplateParams.params)).result)
            const normalizedClassification = classifyDefinitionResult(requestUri, normalizedResult, ctx.savedInitParams?.rootUri ?? null)
            logger.debug(
                'proxy',
                `textDocument/definition template-normalized uri=${requestUri} position=${normalizedTemplateParams.normalizedPosition.line}:${normalizedTemplateParams.normalizedPosition.character} classification=${normalizedClassification.kind} count=${normalizedClassification.count}`
            )
            if (normalizedClassification.kind !== 'empty' && normalizedClassification.kind !== 'self') {
                return finalizeDefinitionResult(ctx, requestUri, normalizedResult)
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.warn('proxy', `textDocument/definition template-normalized ${requestUri} ERROR: ${msg}`)
        }
    }

    const componentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
    if (componentFallback !== null) {
        return componentFallback
    }

    const vueFallback = await requestVueLsDefinitionFallback(ctx, requestUri, vueFallbackParams, `initial-${classification.kind}`)
    if (vueFallback !== null) {
        return vueFallback
    }

    const initialStoreToRefsFallback = requestScriptStoreToRefsDefinitionFallback(ctx, requestUri, params)
    if (initialStoreToRefsFallback !== null) {
        return initialStoreToRefsFallback
    }

    logger.debug(
        'proxy',
        `textDocument/definition retry scheduled uri=${requestUri} delay=${VUE_DEFINITION_RETRY_DELAY_MS}ms classification=${classification.kind}`
    )
    await new Promise<void>((resolve) => setTimeout(resolve, VUE_DEFINITION_RETRY_DELAY_MS))

    try {
        const retryAttempt = await tryDefinitionRequest(ctx, target, params)
        if (retryAttempt.timedOut) {
            logger.warn('proxy', `textDocument/definition retry timeout uri=${requestUri} fallback=vue_ls`)
            const recoveryPromise = maybeRecoverVtslsAfterTimeout(ctx, 'textDocument/definition')
            const retryVueFallback = await requestVueLsDefinitionFallback(ctx, requestUri, vueFallbackParams, 'retry-timeout')
            if (retryVueFallback !== null) {
                return retryVueFallback
            }
            if (recoveryPromise !== null) {
                await recoveryPromise
                const recoveredResult = await requestRecoveredVueDefinition(ctx, requestUri, params, normalizedTemplateParams)
                if (recoveredResult !== null) {
                    return recoveredResult
                }
            }
            return finalizeDefinitionResult(ctx, requestUri, initialResult)
        }

        const retryResult = normalizeDefinitionResult(retryAttempt.result)
        const retryClassification = classifyDefinitionResult(requestUri, retryResult, ctx.savedInitParams?.rootUri ?? null)
        logger.debug('proxy', `textDocument/definition retry uri=${requestUri} classification=${retryClassification.kind} count=${retryClassification.count}`)
        if (hasVueShimDefinition(retryResult)) {
            const retryComponentFallback = requestTemplateComponentDefinitionFallback(ctx, requestUri, params)
            if (retryComponentFallback !== null) {
                return retryComponentFallback
            }
        }
        if (retryClassification.kind === 'empty' || retryClassification.kind === 'self') {
            const retryVueFallback = await requestVueLsDefinitionFallback(ctx, requestUri, vueFallbackParams, `retry-${retryClassification.kind}`)
            if (retryVueFallback !== null) {
                return retryVueFallback
            }
            const sourceResult = await requestImportSourceDefinition(ctx, requestUri, params)
            if (sourceResult !== null) {
                return sourceResult
            }
            const probeResult = await requestImportDefinitionProbe(ctx, requestUri, params)
            if (probeResult !== null) {
                return probeResult
            }
            const storeToRefsFallback = requestScriptStoreToRefsDefinitionFallback(ctx, requestUri, params)
            if (storeToRefsFallback !== null) {
                return storeToRefsFallback
            }
            return finalizeDefinitionResult(ctx, requestUri, initialResult)
        }
        return finalizeDefinitionResult(ctx, requestUri, retryResult)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn('proxy', `textDocument/definition retry ${requestUri} ERROR: ${msg}`)
        return finalizeDefinitionResult(ctx, requestUri, initialResult)
    }
}
