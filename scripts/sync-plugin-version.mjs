// Copies the package.json version into .claude-plugin/plugin.json.
// Runs after `changeset version` so the plugin manifest shown by
// Claude Code's /plugin UI tracks the published npm version.
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const packageJsonPath = path.join(root, 'package.json')
const pluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json')

const { version } = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'))

if (plugin.version !== version) {
    plugin.version = version
    fs.writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 4) + '\n')
    process.stderr.write(`sync-plugin-version: .claude-plugin/plugin.json -> ${version}\n`)
}
