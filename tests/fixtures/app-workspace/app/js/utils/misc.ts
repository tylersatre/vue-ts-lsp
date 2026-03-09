import type { ScenarioRecord, ScenarioLineItem } from 'Domain/generated'
import type { ScenarioCharge, ScenarioSnapshot } from 'Domain/interfaces'
import type { Brand, LineItemId, ScenarioId } from 'Domain/types'

export function formatCurrency(amount: number): string {
    const formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0
    })
    return formatter.format(amount)
}

export function createIdentifier<B extends string>(): Brand<string, B> {
    const seed = Math.random().toString(36).slice(2, 10)
    return `fixture-${seed}` as Brand<string, B>
}

export function logWorkspaceEvent(event: string): string {
    return `tracked:${event}`
}

function buildCharge(name: string, slug: string, amount: number, adjustment = false): ScenarioCharge {
    return {
        identifier: createIdentifier<'ChargeId'>(),
        name,
        slug,
        amount,
        adjustment
    }
}

export function buildScenarioSnapshot(): ScenarioSnapshot {
    return {
        title: 'Spring planning board',
        lastUpdatedAt: '2026-03-11T12:00:00.000Z',
        groups: [
            {
                name: 'Setup',
                slug: 'setup',
                total: 980,
                charges: [buildCharge('Workspace audit', 'workspace-audit', 540), buildCharge('Template cleanup', 'template-cleanup', 440)]
            },
            {
                name: 'Support',
                slug: 'support',
                total: 1260,
                charges: [buildCharge('Follow-up review', 'follow-up-review', 760), buildCharge('Launch credit', 'launch-credit', 500, true)]
            }
        ]
    }
}

export function buildLineItem(identifier: LineItemId, itemIndex: number): ScenarioLineItem {
    return {
        identifier,
        amount: itemIndex === 0 ? 12800 : 16300,
        metric: itemIndex === 0 ? 2.25 : 3.5,
        name: itemIndex === 0 ? 'Core rollout' : `Variant track ${itemIndex + 1}`,
        category: itemIndex === 0 ? 'Baseline' : 'Expansion',
        itemIndex
    }
}

export function buildScenarioRecord(): ScenarioRecord {
    const scenarioId = createIdentifier<'ScenarioId'>() as ScenarioId
    const primaryIdentifier = createIdentifier<'LineItemId'>() as LineItemId
    const comparisonIdentifier = createIdentifier<'LineItemId'>() as LineItemId

    return {
        identifier: scenarioId,
        lineItems: [buildLineItem(primaryIdentifier, 0), buildLineItem(comparisonIdentifier, 1)]
    }
}
