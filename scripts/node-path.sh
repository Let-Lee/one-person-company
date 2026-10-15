# Shared by the macOS launchers; no dependencies are installed automatically.
find_company_node() {
  for company_node in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$company_node" ] && [ -x "$company_node" ] || continue
    if "$company_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
      printf '%s\n' "$company_node"
      return 0
    fi
  done
  printf '%s\n' '需要 Node.js 20 或以上版本。可先用 Homebrew 安装：brew install node@24' >&2
  return 1
}
