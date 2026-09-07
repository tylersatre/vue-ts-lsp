// Copies the package.json version into .claude-plugin/plugin.json.
// Runs after `changeset version` so the plugin manifest shown by
// Claude Code's /plugin UI tracks the published npm version.
import fs from 'node:fs'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

const root = process.cwd()
const packageJsonPath = path.join(root, 'package.json')
const pluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json')

const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'))

if (plugin.version !== version) {
    plugin.version = version
    const options = await resolveConfig(pluginJsonPath)
    fs.writeFileSync(pluginJsonPath, await format(JSON.stringify(plugin), { ...options, filepath: pluginJsonPath }))
    process.stderr.write(`sync-plugin-version: .claude-plugin/plugin.json -> ${version}\n`)
}
