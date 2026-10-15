#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' '一键安装目前仅支持 macOS。其他平台尚未验证。' >&2
  exit 1
fi
# Match an already enabled macOS HTTPS proxy when the terminal has no proxy.
# This changes only this installer process, never the user's system settings.
if [ -z "${HTTPS_PROXY:-${https_proxy:-${ALL_PROXY:-${all_proxy:-}}}}" ]; then
  company_proxy_settings="$(/usr/sbin/scutil --proxy)"
  company_proxy_enabled="$(printf '%s\n' "$company_proxy_settings" | awk '$1 == "HTTPSEnable" { print $3; exit }')"
  company_proxy_host="$(printf '%s\n' "$company_proxy_settings" | awk '$1 == "HTTPSProxy" { print $3; exit }')"
  company_proxy_port="$(printf '%s\n' "$company_proxy_settings" | awk '$1 == "HTTPSPort" { print $3; exit }')"
  if [ "$company_proxy_enabled" = 1 ] && [ -n "$company_proxy_host" ] && [ -n "$company_proxy_port" ]; then
    case "$company_proxy_host" in *:*) company_proxy_host="[$company_proxy_host]";; esac
    export https_proxy="http://$company_proxy_host:$company_proxy_port"
  fi
fi
company_node=''
for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then company_node="$candidate"; break; fi
done
if [ -z "$company_node" ]; then
  printf '%s\n' '请先安装 Node.js 20 或以上版本，例如：brew install node@24；安装后重新运行本命令。' >&2
  exit 1
fi
company_home="${ONE_PERSON_COMPANY_HOME:-$HOME/Applications/OnePersonCompany}"
company_port="${PORT:-4318}"
case "$company_port" in ''|*[!0-9]*) printf '%s\n' 'PORT 必须是 1 至 65535 的整数。' >&2; exit 1;; esac
if [ "$company_port" -lt 1 ] || [ "$company_port" -gt 65535 ]; then printf '%s\n' 'PORT 必须是 1 至 65535 的整数。' >&2; exit 1; fi
if [ -e "$company_home" ] && [ ! -f "$company_home/.one-person-company" ] && [ -n "$(ls -A "$company_home")" ]; then
  printf '%s\n' '目标目录已有其他内容，请用 ONE_PERSON_COMPANY_HOME 选择一个空目录。' >&2
  exit 1
fi
company_temp="$(mktemp -d "${TMPDIR:-/tmp}/one-person-company.XXXXXX")"
trap 'rm -rf "$company_temp"' EXIT
archive_url="${ONE_PERSON_COMPANY_ARCHIVE:-https://github.com/Let-Lee/one-person-company/archive/refs/heads/main.zip}"
printf '%s\n' '正在下载公司源码…'
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 60 --retry 1 "$archive_url" -o "$company_temp/source.zip"
unzip -q "$company_temp/source.zip" -d "$company_temp/source"
company_source=''
for candidate in "$company_temp/source"/*; do if [ -d "$candidate" ]; then company_source="$candidate"; break; fi; done
[ -n "$company_source" ] && [ -f "$company_source/scripts/manage.mjs" ] && [ -f "$company_source/src/server.mjs" ] || { printf '%s\n' '下载内容不是有效的公司发布包。' >&2; exit 1; }
release_id="$(shasum -a 256 "$company_temp/source.zip" | cut -c 1-16)"
mkdir -p "$company_home/releases" "$company_home/data"
printf '%s\n' 'one-person-company' > "$company_home/.one-person-company"
if [ ! -d "$company_home/releases/$release_id" ]; then mv "$company_source" "$company_home/releases/$release_id"; fi
if [ -e "$company_home/current" ] && [ ! -L "$company_home/current" ]; then printf '%s\n' 'current 不是本程序建立的链接，已停止安装。' >&2; exit 1; fi
ln -sfn "$company_home/releases/$release_id" "$company_home/current"
for company_action in start stop; do
  if [ "$company_action" = start ]; then company_launcher='启动公司.command'; else company_launcher='停止公司.command'; fi
  cat > "$company_home/$company_launcher" <<'LAUNCH'
#!/bin/zsh
company_root="${0:A:h}"
export YEWANG_DATA_DIR="$company_root/data"
source "$company_root/current/scripts/node-path.sh"
company_node="$(find_company_node)" || exit 1
LAUNCH
  printf 'export PORT=%s\n' "$company_port" >> "$company_home/$company_launcher"
  printf 'exec "$company_node" "$company_root/current/scripts/manage.mjs" %s --open\n' "$company_action" >> "$company_home/$company_launcher"
  chmod +x "$company_home/$company_launcher"
done
export YEWANG_DATA_DIR="$company_home/data"
"$company_node" "$company_home/current/scripts/manage.mjs" stop
"$company_node" "$company_home/current/scripts/manage.mjs" start --open
printf '已安装到：%s\n以后双击“启动公司.command”即可。岗位与任务保存在 data 中。\n' "$company_home"
