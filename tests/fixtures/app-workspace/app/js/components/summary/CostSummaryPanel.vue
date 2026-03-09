<template>
    <TCard
        title="Scenario Cost Summary"
        data-testid="cost-summary-card"
    >
        <template #header>
            <div
                class="panel-total"
                data-testid="cost-summary-total"
            >
                {{ totalSummaryDisplay }}
            </div>
        </template>

        <TList data-testid="cost-summary-list">
            <div
                v-for="(group, index) in props.snapshot.groups"
                :key="group.slug"
                :data-testid="`cost-group-${index}`"
            >
                <TListTile
                    :name="group.name"
                    :amount="group.total"
                    bold
                >
                    <button
                        class="panel-toggle"
                        type="button"
                        @click="show[group.slug] = !show[group.slug]"
                    >
                        {{ show[group.slug] ? 'Hide' : 'Show' }}
                    </button>
                </TListTile>

                <TransitionGroup name="panel-slide">
                    <div
                        v-for="charge in group.charges"
                        :key="charge.identifier"
                        v-show="show[group.slug]"
                    >
                        <TListTile
                            :name="charge.name"
                            :amount="charge.amount"
                            :adjustment="charge.adjustment"
                            class="panel-sub-fee"
                        />
                    </div>
                </TransitionGroup>
            </div>
        </TList>
    </TCard>
</template>

<script setup lang="ts">
import type { ScenarioSnapshot } from 'Domain/interfaces'
import type { VisibilityMap } from 'Domain/types'
import { formatCurrency } from 'App/utils/misc'
import { forEach } from 'lodash'
import TCard from 'UiKit/components/TCard.vue'
import TList from 'UiKit/components/TList/TList.vue'
import TListTile from 'UiKit/components/TList/TListTile.vue'
import { computed, ref } from 'vue'

interface Props {
    snapshot: ScenarioSnapshot
}

const props = defineProps<Props>()

const show = ref<VisibilityMap>({
    setup: true,
    support: true
})

const totalSummaryCost = computed(() => {
    let total = 0
    forEach(props.snapshot.groups, (group) => {
        total += group.total
    })
    return total
})

const totalSummaryDisplay = computed(() => formatCurrency(totalSummaryCost.value))
</script>

<style scoped lang="scss">
.panel-total {
    font-size: 1.125rem;
    font-weight: 700;
}

.panel-toggle {
    border: 0;
    background: transparent;
    color: #2657ff;
    cursor: pointer;
}

.panel-sub-fee {
    padding-left: 24px;
}
</style>
