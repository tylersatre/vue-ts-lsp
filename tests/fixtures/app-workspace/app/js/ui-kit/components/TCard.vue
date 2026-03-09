<template>
    <section
        class="t-card"
        :data-testid="dataTestid"
    >
        <header class="t-card-header">
            <div>
                <h2 class="t-card-title">{{ title }}</h2>
                <slot name="header"></slot>
            </div>
        </header>
        <div class="t-card-body">
            <slot></slot>
        </div>
    </section>
</template>

<script setup lang="ts">
interface Props {
    title: string
    dataTestid?: string
}

defineProps<Props>()
</script>

<style scoped lang="scss">
.t-card {
    border: 1px solid #d6dfeb;
    border-radius: 16px;
    background: #fff;
    padding: 20px;
}

.t-card-header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    margin-bottom: 16px;
}

.t-card-title {
    margin: 0;
}
</style>
