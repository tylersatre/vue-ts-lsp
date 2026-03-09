<template>
    <div
        class="t-list"
        :data-testid="dataTestid"
    >
        <slot></slot>
    </div>
</template>

<script setup lang="ts">
interface Props {
    dataTestid?: string
}

defineProps<Props>()
</script>

<style scoped lang="scss">
.t-list {
    display: grid;
    gap: 10px;
}
</style>
