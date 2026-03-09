<template>
    <button
        ref="buttonRef"
        class="primary-action"
        :class="{
            'primary-action-selected': selected,
            'primary-action-busy': isPressed
        }"
        :disabled="disabled || noClick"
        @click.prevent="click"
        @mousedown="isPressed = true"
        @mouseup="isPressed = false"
        @mouseleave="isPressed = false"
    >
        <span
            v-if="showIndicator"
            class="primary-action-indicator"
            >●</span
        >
        <span>{{ buttonText }}</span>
        <slot></slot>
    </button>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface Props {
    buttonText?: string
    disabled?: boolean
    noClick?: boolean
    selected?: boolean
    showIndicators?: boolean
}

const props = withDefaults(defineProps<Props>(), {
    buttonText: 'Continue',
    disabled: false,
    noClick: false,
    selected: false,
    showIndicators: false
})

const showIndicator = computed(() => props.showIndicators && props.selected && props.buttonText)

const emit = defineEmits<{
    (e: 'click', event: MouseEvent): void
}>()

const buttonRef = ref<HTMLButtonElement | null>(null)
const isPressed = ref(false)

const click = (event: MouseEvent) => {
    emit('click', event)
}
</script>

<style scoped lang="scss">
.primary-action {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    padding: 12px 18px;
    border: 0;
    border-radius: 999px;
    background: #2657ff;
    color: #fff;
    cursor: pointer;
}

.primary-action-selected {
    background: #1737a6;
}

.primary-action-busy {
    transform: translateY(1px);
}

.primary-action-indicator {
    font-size: 0.75rem;
}
</style>
