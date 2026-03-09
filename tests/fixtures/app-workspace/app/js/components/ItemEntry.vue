<template>
    <section class="item-entry">
        <ActionButton
            button-text="Add Scenario"
            @click="workspaceStore.addEntry"
            v-show="entries.length < 5"
        />
    </section>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from 'State/workspace'
import ActionButton from 'UiKit/components/ActionButton.vue'

const workspaceStore = useWorkspaceStore()
const { entries } = storeToRefs(workspaceStore)
</script>
