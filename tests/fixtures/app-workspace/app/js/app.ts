import { createPinia } from 'pinia'
import 'Theme/v3.scss'
import { createApp } from 'vue'
import AppShell from './components/AppShell.vue'
import router from './router/index'

const app = createApp(AppShell)

app.use(createPinia())
app.use(router)
app.mount('#app')
