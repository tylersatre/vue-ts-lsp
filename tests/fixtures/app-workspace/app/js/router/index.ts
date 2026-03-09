import CostSummaryPanel from 'App/components/summary/CostSummaryPanel.vue'
import { createRouter, createWebHistory } from 'vue-router'

export default createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            component: CostSummaryPanel
        }
    ]
})
