// Process-local configuration for workbench execution. Never writes the user's config.
// These integrations are not connected to the workbench's delegated task flow.
export const WORKBENCH_CONTEXT_PROFILE = Object.freeze({
  version: 1,
  disabledPlugins: [
    'code-review@openai-bundled', 'template-creator@openai-primary-runtime',
    'codex-app-tools@openai-bundled', 'unified-computer-use@openai-bundled',
    'visualize@openai-bundled', 'browser@openai-bundled', 'computer-use@openai-bundled',
    'chrome@openai-bundled', 'documents@openai-primary-runtime', 'pdf@openai-primary-runtime',
    'spreadsheets@openai-primary-runtime', 'presentations@openai-primary-runtime',
  ],
});

export function contextArgs(mode = 'lean') {
  const args = ['app-server', '--listen', 'stdio://'];
  if (mode === 'baseline') return args;
  if (mode !== 'lean') throw new Error('工作台上下文配置模式无效');
  const plugins = `{ ${WORKBENCH_CONTEXT_PROFILE.disabledPlugins.map((name) => `${JSON.stringify(name)} = { enabled = false }`).join(', ')} }`;
  args.push('-c', 'apps._default.enabled=false', '-c', 'features.remote_plugin=false',
    '-c', 'features.apps=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
    '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false',
    '-c', 'features.memories=false', '-c', 'mcp_servers.node_repl.enabled=false',
    '-c', 'mcp_servers.node_repl.command="node"',
    '-c', `plugins=${plugins}`);
  return args;
}
