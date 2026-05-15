#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=tools/linux/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_package_manager >/dev/null
check_node_modules
check_command node

invoke_in_repo run_logged_command 'Local service smoke failed.' node scripts/local-service-smoke.mjs
