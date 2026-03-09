import type { ScenarioSnapshot } from 'Domain/interfaces'
import { formatCurrency } from 'App/utils/misc'

export interface ScenarioSummary {
    totalLabel: string
    groupCount: number
}

export function useSummaryBuilder() {
    function buildSummary(snapshot: ScenarioSnapshot): ScenarioSummary {
        const total = snapshot.groups.reduce((sum, group) => sum + group.total, 0)
        return {
            totalLabel: formatCurrency(total),
            groupCount: snapshot.groups.length
        }
    }

    function buildHeadline(snapshot: ScenarioSnapshot): string {
        return `${buildSummary(snapshot).groupCount} summary groups`
    }

    return {
        buildSummary,
        buildHeadline
    }
}
