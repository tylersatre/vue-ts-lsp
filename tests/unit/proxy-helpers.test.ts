import { describe, expect, it } from 'vitest'
import { classifyDefinitionResult, normalizeDefinitionResult, preferDefinitionResult } from '@src/helpers/definitions.js'
import { hoverResultLooksAny } from '@src/helpers/hover.js'
import { extractRequestUri, extractIdentifierAtPosition } from '@src/helpers/identifiers.js'
import {
    findVueImportAtPosition,
    normalizeVueImportPosition,
    findImportAtPosition,
    normalizeImportPosition,
    findImportByLocalName
} from '@src/helpers/imports.js'
import { createDefinitionProbe, isInternalProbeUri } from '@src/helpers/probes.js'
import { findReferenceTargetAtPosition, collectIdentifierReferencesInDocument, collectReferenceTargetsForChanges } from '@src/helpers/references.js'
import { findScriptSymbolByName, normalizeDocumentSymbolKinds } from '@src/helpers/symbols.js'
import { parseTsserverRequest, summarizeBridgeResponseBody } from '@src/helpers/tsserver.js'
import { findVueTemplateComponentAtPosition, normalizeVueTemplateExpressionPosition, isVueTemplatePosition } from '@src/helpers/vue-template.js'

describe('parseTsserverRequest', () => {
    it('accepts the flat vue_ls payload shape', () => {
        expect(parseTsserverRequest([7, '_vue:projectInfo', { file: 'App.vue' }])).toEqual({
            id: 7,
            command: '_vue:projectInfo',
            args: { file: 'App.vue' },
            shape: 'flat'
        })
    })

    it('accepts the legacy nested payload shape', () => {
        expect(parseTsserverRequest([[42, 'getDefinition', { file: 'App.vue' }]])).toEqual({
            id: 42,
            command: 'getDefinition',
            args: { file: 'App.vue' },
            shape: 'nested'
        })
    })

    it('returns null for an invalid payload', () => {
        expect(parseTsserverRequest({ id: 1 })).toBeNull()
    })
})

describe('extractRequestUri', () => {
    it('extracts textDocument.uri', () => {
        expect(extractRequestUri({ textDocument: { uri: 'file:///workspace/App.vue' } })).toBe('file:///workspace/App.vue')
    })

    it('extracts item.uri for call hierarchy requests', () => {
        expect(extractRequestUri({ item: { uri: 'file:///workspace/App.vue' } })).toBe('file:///workspace/App.vue')
    })
})

describe('classifyDefinitionResult', () => {
    const requestUri = 'file:///workspace/App.vue'
    const workspaceRootUri = 'file:///workspace'

    it('classifies empty results', () => {
        expect(classifyDefinitionResult(requestUri, [], workspaceRootUri)).toMatchObject({
            kind: 'empty',
            count: 0
        })
    })

    it('classifies self-target results', () => {
        expect(classifyDefinitionResult(requestUri, [{ targetUri: requestUri }], workspaceRootUri)).toMatchObject({
            kind: 'self',
            count: 1,
            hasSelf: true
        })
    })

    it('classifies workspace-target results', () => {
        expect(classifyDefinitionResult(requestUri, [{ uri: 'file:///workspace/src/helpers.ts' }], workspaceRootUri)).toMatchObject({
            kind: 'workspace',
            count: 1,
            hasWorkspace: true
        })
    })

    it('classifies external-library results', () => {
        expect(
            classifyDefinitionResult(
                requestUri,
                [
                    {
                        uri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.d.ts'
                    }
                ],
                workspaceRootUri
            )
        ).toMatchObject({
            kind: 'external-library',
            count: 1,
            hasExternalLibrary: true
        })
    })
})

describe('summarizeBridgeResponseBody', () => {
    it('summarizes null bodies', () => {
        expect(summarizeBridgeResponseBody(null)).toBe('null')
    })

    it('summarizes arrays by length', () => {
        expect(summarizeBridgeResponseBody([1, 2])).toBe('array(2)')
    })

    it('summarizes objects by key count', () => {
        expect(summarizeBridgeResponseBody({ body: true, extra: 1 })).toBe('object(2)')
    })
})

const VUE_IMPORT_FIXTURE = `<template>
  <button @click="click">Button</button>
</template>

<script setup lang="ts">
import Foo, { computed, ref as localRef } from 'vue'
import * as VueNs from 'vue'
</script>
`

const TS_IMPORT_FIXTURE = `import Foo, { computed, ref as localRef } from 'vue'
import * as VueNs from 'vue'

export const derived = computed(() => localRef)
`

const VUE_TEMPLATE_FIXTURE = `<template>
  <CurrencyField
    v-model="fee.amount"
    @click="workspaceStore.addEntry"
  />
  <TextField v-model="fee.name" />
</template>

<script setup lang="ts">
import CurrencyField from 'Fields/CurrencyField.vue'
import TextField from './TextField.vue'
const workspaceStore = useWorkspaceStore()
</script>
`

const TYPE_REFERENCE_FIXTURE = `export type Brand<T, B extends string> = T & { readonly __brand: B }

export type LineItemId = Brand<string, 'LineItemId'>

export interface LineItemRecord {
  identifier: LineItemId
}
`

const ITEM_DETAILS_FIXTURE = `<template>
  <ScenarioRow v-for="entry in props.items" :key="entry.identifier" />
  <button @click="scenariosStore.runScenarioPreview(entry.identifier)">
    Preview Scenario
  </button>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import type { LineItemId } from 'Domain/types'

interface ItemDetailsProps {
  items: Array<{ identifier: LineItemId }>
}

const props = defineProps<ItemDetailsProps>()
const scenariosStore = useScenariosStore()
const { currentLineup, lineItemCount } = storeToRefs(scenariosStore)

function runScenarioPreview(identifier: LineItemId) {
  return identifier
}
</script>
`

const EXPORTED_SIGNATURE_OLD = `export function modifySingleFeeUsingConditions(loanAmount: number) {
  return loanAmount
}
`

const EXPORTED_SIGNATURE_NEW = `export function modifySingleFeeUsingConditions(loanAmount: boolean) {
  return loanAmount
}
`

const PINIA_STORE_OLD = `export const useUiStore = defineStore('ui', () => {
  const goToTab = (slug: 'details' | 'payment' | 'estimate') => slug
  return { goToTab }
})
`

const PINIA_STORE_NEW = `export const useUiStore = defineStore('ui', () => {
  const goToTab = (slug: 'details' | 'payment') => slug
  return { goToTab }
})
`

describe('findVueImportAtPosition', () => {
    it('finds named imports inside a Vue script block', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 5, character: 14 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'computed',
            localName: 'computed'
        })
    })

    it('finds aliased named imports inside a Vue script block', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 5, character: 29 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'ref',
            localName: 'localRef'
        })
    })

    it('snaps module-specifier whitespace to the nearest named import inside a Vue script block', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 5, character: 46 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'ref',
            localName: 'localRef'
        })
    })

    it('returns the normalized local position for module-specifier whitespace inside an import', () => {
        expect(
            normalizeVueImportPosition(VUE_IMPORT_FIXTURE, {
                line: 5,
                character: 46
            })
        ).toEqual({ line: 5, character: 31 })
    })

    it('finds default imports inside a Vue script block', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 5, character: 7 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'default',
            importedName: null,
            localName: 'Foo'
        })
    })

    it('finds namespace imports inside a Vue script block', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 6, character: 13 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'namespace',
            importedName: null,
            localName: 'VueNs'
        })
    })

    it('returns null outside Vue script blocks', () => {
        expect(findVueImportAtPosition(VUE_IMPORT_FIXTURE, { line: 1, character: 11 })).toBeNull()
    })
})

describe('findImportAtPosition', () => {
    it('finds named imports inside a TypeScript file', () => {
        expect(findImportAtPosition(TS_IMPORT_FIXTURE, { line: 0, character: 14 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'computed',
            localName: 'computed'
        })
    })

    it('finds aliased named imports inside a TypeScript file', () => {
        expect(findImportAtPosition(TS_IMPORT_FIXTURE, { line: 0, character: 29 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'ref',
            localName: 'localRef'
        })
    })

    it('snaps module-specifier whitespace to the nearest named import inside a TypeScript file', () => {
        expect(findImportAtPosition(TS_IMPORT_FIXTURE, { line: 0, character: 46 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'ref',
            localName: 'localRef'
        })
    })

    it('returns the normalized local position for module-specifier whitespace inside a TypeScript import', () => {
        expect(normalizeImportPosition(TS_IMPORT_FIXTURE, { line: 0, character: 46 })).toEqual({ line: 0, character: 31 })
    })

    it('finds namespace imports inside a TypeScript file', () => {
        expect(findImportAtPosition(TS_IMPORT_FIXTURE, { line: 1, character: 13 })).toEqual({
            moduleSpecifier: 'vue',
            importKind: 'namespace',
            importedName: null,
            localName: 'VueNs'
        })
    })
})

describe('hoverResultLooksAny', () => {
    it('detects low-quality any hover results', () => {
        expect(
            hoverResultLooksAny({
                contents: {
                    language: 'typescript',
                    value: 'const entry: any'
                }
            })
        ).toBe(true)
    })

    it('ignores specific hover results', () => {
        expect(
            hoverResultLooksAny({
                contents: {
                    language: 'typescript',
                    value: 'const loan: ScenarioLineItem'
                }
            })
        ).toBe(false)
    })
})

describe('isVueTemplatePosition', () => {
    it('detects template positions', () => {
        expect(isVueTemplatePosition(ITEM_DETAILS_FIXTURE, { line: 1, character: 26 })).toBe(true)
    })

    it('detects script positions', () => {
        expect(isVueTemplatePosition(ITEM_DETAILS_FIXTURE, { line: 15, character: 8 })).toBe(false)
    })
})

describe('findReferenceTargetAtPosition', () => {
    it('finds exported type aliases', () => {
        expect(findReferenceTargetAtPosition('file:///workspace/definitions/types.ts', TYPE_REFERENCE_FIXTURE, { line: 2, character: 15 })).toMatchObject({
            name: 'LineItemId',
            kind: 'type-alias',
            exported: true
        })
    })

    it('finds Vue component tags in templates', () => {
        expect(findReferenceTargetAtPosition('file:///workspace/components/ItemDetails.vue', ITEM_DETAILS_FIXTURE, { line: 1, character: 7 })).toMatchObject({
            name: 'ScenarioRow',
            kind: 'component'
        })
    })

    it('treats function-valued variable declarations as functions', () => {
        expect(
            findReferenceTargetAtPosition('file:///workspace/stores/ui.ts', 'export const goToTab = function (tab: string) {\n  return tab\n}\n', {
                line: 0,
                character: 15
            })
        ).toMatchObject({
            name: 'goToTab',
            kind: 'function',
            exported: true
        })
    })

    it('infers the component name when referencing a Vue file from line 1', () => {
        expect(
            findReferenceTargetAtPosition('file:///workspace/components/FeesCard.vue', '<template>\n  <section>Fees</section>\n</template>\n', {
                line: 0,
                character: 0
            })
        ).toMatchObject({
            name: 'FeesCard',
            kind: 'component',
            exported: true
        })
    })

    it('finds Vue script methods', () => {
        expect(findReferenceTargetAtPosition('file:///workspace/components/ItemDetails.vue', ITEM_DETAILS_FIXTURE, { line: 19, character: 12 })).toMatchObject({
            name: 'runScenarioPreview',
            kind: 'function'
        })
    })
})

describe('collectIdentifierReferencesInDocument', () => {
    it('collects type references across TypeScript declarations', () => {
        const locations = collectIdentifierReferencesInDocument('file:///workspace/definitions/types.ts', TYPE_REFERENCE_FIXTURE, 'LineItemId')

        expect(locations).toHaveLength(2)
        expect(locations[0]?.range.start).toEqual({ line: 2, character: 12 })
        expect(locations[1]?.range.start).toEqual({ line: 5, character: 14 })
    })

    it('collects Vue template expression references', () => {
        const locations = collectIdentifierReferencesInDocument('file:///workspace/components/ItemDetails.vue', ITEM_DETAILS_FIXTURE, 'runScenarioPreview')

        expect(locations.some((location) => location.range.start.line === 2 && location.range.start.character === 33)).toBe(true)
        expect(locations.some((location) => location.range.start.line === 19 && location.range.start.character === 9)).toBe(true)
    })
})

describe('collectReferenceTargetsForChanges', () => {
    it('tracks exported function signature edits by the function symbol', () => {
        expect(
            collectReferenceTargetsForChanges('file:///workspace/helpers/fees.ts', EXPORTED_SIGNATURE_OLD, EXPORTED_SIGNATURE_NEW, [
                {
                    range: {
                        start: { line: 0, character: 60 },
                        end: { line: 0, character: 66 }
                    },
                    text: 'boolean'
                }
            ])
        ).toMatchObject([
            {
                name: 'modifySingleFeeUsingConditions',
                kind: 'function',
                exported: true
            }
        ])
    })

    it('tracks nested store methods by the returned function symbol', () => {
        expect(
            collectReferenceTargetsForChanges('file:///workspace/stores/ui.ts', PINIA_STORE_OLD, PINIA_STORE_NEW, [
                {
                    range: {
                        start: { line: 1, character: 48 },
                        end: { line: 1, character: 59 }
                    },
                    text: ''
                }
            ])
        ).toMatchObject([
            {
                name: 'goToTab',
                kind: 'function',
                exported: false
            }
        ])
    })

    it('infers changed targets for full-document replacements', () => {
        expect(
            collectReferenceTargetsForChanges('file:///workspace/helpers/fees.ts', EXPORTED_SIGNATURE_OLD, EXPORTED_SIGNATURE_NEW, [
                {
                    text: EXPORTED_SIGNATURE_NEW
                }
            ])
        ).toMatchObject([
            {
                name: 'modifySingleFeeUsingConditions',
                kind: 'function'
            }
        ])
    })
})

describe('findImportByLocalName', () => {
    it('finds default imports by local name inside a Vue script block', () => {
        expect(findImportByLocalName(VUE_TEMPLATE_FIXTURE, 'CurrencyField')).toEqual({
            moduleSpecifier: 'Fields/CurrencyField.vue',
            importKind: 'default',
            importedName: null,
            localName: 'CurrencyField'
        })
    })
})

describe('normalizeDefinitionResult', () => {
    it('converts a single LocationLink into a plain Location', () => {
        expect(
            normalizeDefinitionResult({
                targetUri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                targetSelectionRange: {
                    start: { line: 10, character: 4 },
                    end: { line: 10, character: 12 }
                },
                targetRange: {
                    start: { line: 10, character: 0 },
                    end: { line: 14, character: 1 }
                }
            })
        ).toEqual({
            uri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
            range: {
                start: { line: 10, character: 4 },
                end: { line: 10, character: 12 }
            }
        })
    })

    it('converts LocationLink arrays into Location arrays', () => {
        expect(
            normalizeDefinitionResult([
                {
                    targetUri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.d.ts',
                    targetSelectionRange: {
                        start: { line: 100, character: 2 },
                        end: { line: 100, character: 10 }
                    },
                    targetRange: {
                        start: { line: 100, character: 0 },
                        end: { line: 110, character: 0 }
                    }
                }
            ])
        ).toEqual([
            {
                uri: 'file:///workspace/node_modules/%40vue/runtime-core/dist/runtime-core.d.ts',
                range: {
                    start: { line: 100, character: 2 },
                    end: { line: 100, character: 10 }
                }
            }
        ])
    })

    it('filters internal probe locations while normalizing', () => {
        expect(
            normalizeDefinitionResult([
                {
                    targetUri: 'file:///workspace/components/.__vue_ts_lsp__.App.vue.ts',
                    targetSelectionRange: {
                        start: { line: 1, character: 0 },
                        end: { line: 1, character: 3 }
                    }
                },
                {
                    targetUri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                    targetSelectionRange: {
                        start: { line: 10, character: 4 },
                        end: { line: 10, character: 12 }
                    }
                }
            ])
        ).toEqual([
            {
                uri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                range: {
                    start: { line: 10, character: 4 },
                    end: { line: 10, character: 12 }
                }
            }
        ])
    })
})

describe('preferDefinitionResult', () => {
    const workspaceRootUri = 'file:///workspace'
    const requestUri = 'file:///workspace/components/App.vue'

    it('prefers workspace targets over external-library targets', () => {
        expect(
            preferDefinitionResult(
                requestUri,
                [
                    {
                        uri: 'file:///workspace/src/useFeature.ts',
                        range: {
                            start: { line: 10, character: 0 },
                            end: { line: 10, character: 12 }
                        }
                    },
                    {
                        uri: 'file:///workspace/node_modules/pinia/dist/pinia.d.ts',
                        range: {
                            start: { line: 120, character: 0 },
                            end: { line: 120, character: 16 }
                        }
                    }
                ],
                workspaceRootUri
            )
        ).toEqual([
            {
                uri: 'file:///workspace/src/useFeature.ts',
                range: {
                    start: { line: 10, character: 0 },
                    end: { line: 10, character: 12 }
                }
            }
        ])
    })

    it('prefers external-library targets over self-targets', () => {
        expect(
            preferDefinitionResult(
                requestUri,
                [
                    {
                        uri: requestUri,
                        range: {
                            start: { line: 4, character: 0 },
                            end: { line: 4, character: 8 }
                        }
                    },
                    {
                        uri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                        range: {
                            start: { line: 90, character: 0 },
                            end: { line: 90, character: 8 }
                        }
                    }
                ],
                workspaceRootUri
            )
        ).toEqual([
            {
                uri: 'file:///workspace/node_modules/vue/dist/vue.d.ts',
                range: {
                    start: { line: 90, character: 0 },
                    end: { line: 90, character: 8 }
                }
            }
        ])
    })
})

describe('createDefinitionProbe', () => {
    it('builds a stable internal probe document for named imports', () => {
        const probe = createDefinitionProbe('file:///workspace/components/App.vue', {
            moduleSpecifier: 'vue',
            importKind: 'named',
            importedName: 'ref',
            localName: 'localRef'
        })

        expect(isInternalProbeUri(probe.uri)).toBe(true)
        expect(probe.text).toContain(`import { ref as __vue_ts_lsp_probe__ } from 'vue';`)
        expect(probe.position).toEqual({ line: 1, character: 0 })
    })
})

describe('extractIdentifierAtPosition', () => {
    const IDENTIFIER_FIXTURE = `export const useSelectionStore = () => {}\nconst total = useSelectionStore()\n`

    it('extracts the identifier under the cursor', () => {
        expect(
            extractIdentifierAtPosition(IDENTIFIER_FIXTURE, {
                line: 1,
                character: 16
            })
        ).toBe('useSelectionStore')
    })

    it('returns null when the cursor is on whitespace', () => {
        expect(
            extractIdentifierAtPosition(IDENTIFIER_FIXTURE, {
                line: 1,
                character: 13
            })
        ).toBeNull()
    })
})

describe('Vue template helpers', () => {
    it('finds component tags at the template position', () => {
        expect(
            findVueTemplateComponentAtPosition(VUE_TEMPLATE_FIXTURE, {
                line: 1,
                character: 10
            })
        ).toBe('CurrencyField')
    })

    it('normalizes a template member access position to the final segment', () => {
        expect(
            normalizeVueTemplateExpressionPosition(VUE_TEMPLATE_FIXTURE, {
                line: 3,
                character: 19
            })
        ).toEqual({ line: 3, character: 27 })
    })

    it('normalizes a v-model expression position to the bound property segment', () => {
        expect(
            normalizeVueTemplateExpressionPosition(VUE_TEMPLATE_FIXTURE, {
                line: 2,
                character: 16
            })
        ).toEqual({ line: 2, character: 17 })
    })
})

describe('normalizeDocumentSymbolKinds', () => {
    const DOMAIN_TYPES_FIXTURE = `export type Brand<T, B extends string> = T & { readonly __brand: B }\nexport interface VisibilityMap {\n  [key: string]: boolean\n}\nexport enum FeeKind {\n  Credit = 'credit',\n}\n`
    const RAW_SYMBOLS = [
        {
            name: 'Brand',
            kind: 13,
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 66 }
            },
            selectionRange: {
                start: { line: 0, character: 12 },
                end: { line: 0, character: 17 }
            }
        },
        {
            name: 'VisibilityMap',
            kind: 13,
            range: {
                start: { line: 1, character: 0 },
                end: { line: 3, character: 1 }
            },
            selectionRange: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 31 }
            }
        },
        {
            name: 'FeeKind',
            kind: 13,
            range: {
                start: { line: 4, character: 0 },
                end: { line: 6, character: 1 }
            },
            selectionRange: {
                start: { line: 4, character: 12 },
                end: { line: 4, character: 19 }
            }
        }
    ]

    it('remaps type aliases, interfaces, and enums away from Variable', () => {
        expect(normalizeDocumentSymbolKinds('file:///workspace/app/js/domain/types.ts', DOMAIN_TYPES_FIXTURE, RAW_SYMBOLS)).toEqual([
            {
                name: 'Brand',
                kind: 26,
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 66 }
                },
                selectionRange: {
                    start: { line: 0, character: 12 },
                    end: { line: 0, character: 17 }
                }
            },
            {
                name: 'VisibilityMap',
                kind: 11,
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 3, character: 1 }
                },
                selectionRange: {
                    start: { line: 1, character: 17 },
                    end: { line: 1, character: 31 }
                }
            },
            {
                name: 'FeeKind',
                kind: 10,
                range: {
                    start: { line: 4, character: 0 },
                    end: { line: 6, character: 1 }
                },
                selectionRange: {
                    start: { line: 4, character: 12 },
                    end: { line: 4, character: 19 }
                }
            }
        ])
    })
})

describe('findScriptSymbolByName', () => {
    const SCRIPT_FIXTURE = `export function useSummaryBuilder() {\n  function buildSummary() {\n    return 1\n  }\n\n  return {\n    buildSummary,\n  }\n}\n`

    it('finds nested function declarations by name', () => {
        expect(findScriptSymbolByName(SCRIPT_FIXTURE, 'buildSummary', 'file:///workspace/app/js/utils/summary/useSummaryBuilder.ts')).toMatchObject({
            uri: 'file:///workspace/app/js/utils/summary/useSummaryBuilder.ts',
            name: 'buildSummary',
            kind: 12,
            selectionRange: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 23 }
            }
        })
    })
})
