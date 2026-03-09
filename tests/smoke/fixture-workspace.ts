import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_PROJECT_ROOT = path.resolve(process.cwd(), 'tests', 'fixtures', 'app-workspace')
export const PROJECT_ROOT = process.env.VUE_TS_LSP_SMOKE_ROOT ?? DEFAULT_PROJECT_ROOT
export const ROOT_URI = pathToFileURL(PROJECT_ROOT).href
export const FIXTURE_NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules', 'vue')
export const WORKSPACE_NAME = path.basename(PROJECT_ROOT)

export function resolveWorkspaceFile(...candidates: string[][]): string {
    for (const candidate of candidates) {
        const fullPath = path.join(PROJECT_ROOT, ...candidate)
        if (fs.existsSync(fullPath)) {
            return fullPath
        }
    }

    return path.join(PROJECT_ROOT, ...candidates[0]!)
}

function readFixtureFile(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

export const BUTTON_COMPONENT_PATH = resolveWorkspaceFile(
    ['app', 'js', 'ui-kit', 'components', 'PrimaryAction.vue'],
    ['app', 'js', 'ui-kit', 'components', 'ActionButton.vue']
)
export const BUTTON_COMPONENT_URI = pathToFileURL(BUTTON_COMPONENT_PATH).href
export const BUTTON_COMPONENT_TEXT = readFixtureFile(BUTTON_COMPONENT_PATH)

export const SUMMARY_PANEL_PATH = resolveWorkspaceFile(['app', 'js', 'components', 'summary', 'CostSummaryPanel.vue'])
export const SUMMARY_PANEL_URI = pathToFileURL(SUMMARY_PANEL_PATH).href
export const SUMMARY_PANEL_TEXT = readFixtureFile(SUMMARY_PANEL_PATH)

export const DRAFT_SYNC_PATH = resolveWorkspaceFile(['app', 'js', 'composables', 'useDraftSync.ts'])
export const DRAFT_SYNC_URI = pathToFileURL(DRAFT_SYNC_PATH).href
export const DRAFT_SYNC_TEXT = readFixtureFile(DRAFT_SYNC_PATH)

export const DOMAIN_TYPES_PATH = resolveWorkspaceFile(['app', 'js', 'domain', 'types.ts'])
export const DOMAIN_TYPES_URI = pathToFileURL(DOMAIN_TYPES_PATH).href
export const DOMAIN_TYPES_TEXT = readFixtureFile(DOMAIN_TYPES_PATH)

export const DOMAIN_INTERFACES_PATH = resolveWorkspaceFile(['app', 'js', 'domain', 'interfaces.ts'])
export const DOMAIN_INTERFACES_URI = pathToFileURL(DOMAIN_INTERFACES_PATH).href

export const SUMMARY_BUILDER_PATH = resolveWorkspaceFile(['app', 'js', 'utils', 'summary', 'useSummaryBuilder.ts'])
export const SUMMARY_BUILDER_URI = pathToFileURL(SUMMARY_BUILDER_PATH).href
export const SUMMARY_BUILDER_TEXT = readFixtureFile(SUMMARY_BUILDER_PATH)

export const SCENARIO_OVERVIEW_PATH = resolveWorkspaceFile(['app', 'js', 'components', 'ScenarioOverview.vue'])
export const SCENARIO_OVERVIEW_URI = pathToFileURL(SCENARIO_OVERVIEW_PATH).href
export const SCENARIO_OVERVIEW_TEXT = readFixtureFile(SCENARIO_OVERVIEW_PATH)

export const CHARGE_EDITOR_PATH = resolveWorkspaceFile(['app', 'js', 'components', 'charges', 'ChargeEditor.vue'])
export const CHARGE_EDITOR_URI = pathToFileURL(CHARGE_EDITOR_PATH).href
export const CHARGE_EDITOR_TEXT = readFixtureFile(CHARGE_EDITOR_PATH)

export const CURRENCY_FIELD_PATH = resolveWorkspaceFile(['app', 'js', 'ui-kit', 'components', 'fields', 'CurrencyField.vue'])
export const CURRENCY_FIELD_URI = pathToFileURL(CURRENCY_FIELD_PATH).href

export const ITEM_ENTRY_PATH = resolveWorkspaceFile(['app', 'js', 'components', 'ItemEntry.vue'])
export const ITEM_ENTRY_URI = pathToFileURL(ITEM_ENTRY_PATH).href
export const ITEM_ENTRY_TEXT = readFixtureFile(ITEM_ENTRY_PATH)

export const ITEM_DETAILS_PATH = resolveWorkspaceFile(['app', 'js', 'components', 'items', 'ItemDetails.vue'])
export const ITEM_DETAILS_URI = pathToFileURL(ITEM_DETAILS_PATH).href
export const ITEM_DETAILS_TEXT = readFixtureFile(ITEM_DETAILS_PATH)

export const WORKSPACE_STORE_PATH = resolveWorkspaceFile(['app', 'js', 'state', 'workspace.ts'])
export const WORKSPACE_STORE_URI = pathToFileURL(WORKSPACE_STORE_PATH).href

export const SCENARIOS_STORE_PATH = resolveWorkspaceFile(['app', 'js', 'state', 'scenarios.ts'])
export const SCENARIOS_STORE_URI = pathToFileURL(SCENARIOS_STORE_PATH).href
export const SCENARIOS_STORE_TEXT = readFixtureFile(SCENARIOS_STORE_PATH)

export const GENERATED_TYPES_PATH = resolveWorkspaceFile(['app', 'js', 'domain', 'generated.ts'])
export const GENERATED_TYPES_URI = pathToFileURL(GENERATED_TYPES_PATH).href

export const smokeEnabled =
    fs.existsSync(PROJECT_ROOT) &&
    fs.existsSync(BUTTON_COMPONENT_PATH) &&
    fs.existsSync(SUMMARY_PANEL_PATH) &&
    fs.existsSync(DRAFT_SYNC_PATH) &&
    fs.existsSync(DOMAIN_TYPES_PATH) &&
    fs.existsSync(SUMMARY_BUILDER_PATH) &&
    fs.existsSync(SCENARIO_OVERVIEW_PATH) &&
    fs.existsSync(CHARGE_EDITOR_PATH) &&
    fs.existsSync(CURRENCY_FIELD_PATH) &&
    fs.existsSync(ITEM_ENTRY_PATH) &&
    fs.existsSync(ITEM_DETAILS_PATH) &&
    fs.existsSync(WORKSPACE_STORE_PATH) &&
    fs.existsSync(SCENARIOS_STORE_PATH) &&
    fs.existsSync(GENERATED_TYPES_PATH) &&
    fs.existsSync(FIXTURE_NODE_MODULES)

function indexToPosition(text: string, index: number): { line: number; character: number } {
    const prior = text.slice(0, index).split('\n')
    return { line: prior.length - 1, character: prior[prior.length - 1]!.length }
}

export function positionOf(text: string, needle: string, occurrence = 1): { line: number; character: number } {
    let fromIndex = 0
    let index = -1

    for (let i = 0; i < occurrence; i += 1) {
        index = text.indexOf(needle, fromIndex)
        if (index < 0) {
            throw new Error(`Could not find "${needle}" occurrence ${occurrence}`)
        }
        fromIndex = index + needle.length
    }

    return indexToPosition(text, index)
}

export function firstPositionOf(text: string, needles: string[]): { line: number; character: number } {
    for (const needle of needles) {
        const index = text.indexOf(needle)
        if (index >= 0) {
            return indexToPosition(text, index)
        }
    }

    throw new Error(`Could not find any of: ${needles.join(', ')}`)
}

function positionInVueImport(text: string, importedName: 'computed' | 'ref'): { line: number; character: number } {
    const importLineIndex = text.indexOf("import { computed, ref } from 'vue'")
    if (importLineIndex < 0) {
        throw new Error('Could not find the Vue import line in the fixture workspace')
    }

    const importIndex = text.indexOf(importedName, importLineIndex)
    if (importIndex < 0) {
        throw new Error(`Could not find "${importedName}" in the Vue import line`)
    }

    return indexToPosition(text, importIndex)
}

export const BUTTON_COMPONENT_COMPUTED_REPORT_POSITION =
    BUTTON_COMPONENT_TEXT.length > 0 ? positionInVueImport(BUTTON_COMPONENT_TEXT, 'computed') : { line: 0, character: 0 }

export const BUTTON_COMPONENT_REF_TOKEN_POSITION =
    BUTTON_COMPONENT_TEXT.length > 0 ? positionInVueImport(BUTTON_COMPONENT_TEXT, 'ref') : { line: 0, character: 0 }

export const SUMMARY_PANEL_COMPUTED_REPORT_POSITION =
    SUMMARY_PANEL_TEXT.length > 0 ? positionInVueImport(SUMMARY_PANEL_TEXT, 'computed') : { line: 0, character: 0 }

export const SUMMARY_PANEL_REF_TOKEN_POSITION = SUMMARY_PANEL_TEXT.length > 0 ? positionInVueImport(SUMMARY_PANEL_TEXT, 'ref') : { line: 0, character: 0 }

export const DRAFT_SYNC_COMPUTED_REPORT_POSITION = DRAFT_SYNC_TEXT.length > 0 ? positionInVueImport(DRAFT_SYNC_TEXT, 'computed') : { line: 0, character: 0 }

export const DRAFT_SYNC_REF_TOKEN_POSITION = DRAFT_SYNC_TEXT.length > 0 ? positionInVueImport(DRAFT_SYNC_TEXT, 'ref') : { line: 0, character: 0 }

export const DRAFT_SYNC_STORE_POSITION = DRAFT_SYNC_TEXT.length > 0 ? positionOf(DRAFT_SYNC_TEXT, 'useSelectionStore', 2) : { line: 0, character: 0 }

export const SCENARIO_OVERVIEW_BUILD_SUMMARY_POSITION =
    SCENARIO_OVERVIEW_TEXT.length > 0 ? positionOf(SCENARIO_OVERVIEW_TEXT, 'buildSummary') : { line: 0, character: 0 }

export const CHARGE_EDITOR_CURRENCY_FIELD_TAG_POSITION =
    CHARGE_EDITOR_TEXT.length > 0 ? positionOf(CHARGE_EDITOR_TEXT, 'CurrencyField') : { line: 0, character: 0 }

export const CHARGE_EDITOR_CURRENCY_MODEL_POSITION = CHARGE_EDITOR_TEXT.length > 0 ? positionOf(CHARGE_EDITOR_TEXT, 'charge.amount') : { line: 0, character: 0 }

export const CHARGE_EDITOR_TEXT_MODEL_POSITION = CHARGE_EDITOR_TEXT.length > 0 ? positionOf(CHARGE_EDITOR_TEXT, 'charge.name') : { line: 0, character: 0 }

export const ITEM_ENTRY_ADD_SCENARIO_POSITION = ITEM_ENTRY_TEXT.length > 0 ? positionOf(ITEM_ENTRY_TEXT, 'workspaceStore.addEntry') : { line: 0, character: 0 }

export const DOMAIN_TYPES_LINE_ITEM_ID_POSITION = DOMAIN_TYPES_TEXT.length > 0 ? positionOf(DOMAIN_TYPES_TEXT, 'LineItemId', 1) : { line: 0, character: 0 }

export const ITEM_DETAILS_PROPS_POSITION = ITEM_DETAILS_TEXT.length > 0 ? positionOf(ITEM_DETAILS_TEXT, 'props = defineProps') : { line: 0, character: 0 }

export const ITEM_DETAILS_VFOR_ENTRY_POSITION =
    ITEM_DETAILS_TEXT.length > 0 ? positionOf(ITEM_DETAILS_TEXT, 'lineItem.identifier', 1) : { line: 0, character: 0 }

export const ITEM_DETAILS_LINE_ITEM_COUNT_POSITION =
    ITEM_DETAILS_TEXT.length > 0 ? positionOf(ITEM_DETAILS_TEXT, 'lineItemCount', 2) : { line: 0, character: 0 }

export const SCENARIOS_STORE_RUN_PREVIEW_POSITION =
    SCENARIOS_STORE_TEXT.length > 0 ? positionOf(SCENARIOS_STORE_TEXT, 'runScenarioPreview') : { line: 0, character: 0 }
