#!/usr/bin/env bash
set -euo pipefail

# Simple local installer for Daymark CLI (`daymark`), MCP server (`daymark-mcp`),
# and Standalone Web Dashboard (`daymark-web`) without publishing to public npm first.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PREFIX_DIR="${DAYMARK_INSTALL_PREFIX:-${HOME}/.local}"
BIN_DIR="${PREFIX_DIR}/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 22.12.0 is required." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required to build from source." >&2
  exit 1
fi

echo "Building Daymark workspace in ${ROOT_DIR}..."
(cd "${ROOT_DIR}" && pnpm install --frozen-lockfile && pnpm build)

mkdir -p "${BIN_DIR}"

install_wrapper() {
  local name="$1"
  local target_rel="$2"
  local wrapper="${BIN_DIR}/${name}"
  cat > "${wrapper}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${ROOT_DIR}/${target_rel}" "\$@"
EOF
  chmod +x "${wrapper}"
  echo "Installed ${wrapper} -> ${ROOT_DIR}/${target_rel}"
}

install_wrapper "daymark" "packages/cli/dist/bin.mjs"
install_wrapper "daymark-mcp" "packages/mcp-server/dist/bin.mjs"
install_wrapper "daymark-web" "apps/web/dist/server/bin.mjs"

echo ""
echo "Done. Ensure ${BIN_DIR} is on your PATH, then verify:"
echo "  daymark --version"
echo "  daymark init"
echo "  daymark doctor"
