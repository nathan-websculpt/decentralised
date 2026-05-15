#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=tools/linux/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec bash "${SCRIPT_DIR}/test.sh" --test-filter localSyncSmoke