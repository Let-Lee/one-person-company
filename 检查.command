#!/bin/zsh
company_dir="${0:A:h}"
source "$company_dir/scripts/node-path.sh"
company_node="$(find_company_node)" || exit 1
"$company_node" "$company_dir/scripts/manage.mjs" doctor
read -k 1 '?按任意键关闭'
