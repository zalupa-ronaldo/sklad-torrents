#!/bin/sh
# Next standalone server.js binds process.env.HOSTNAME. Docker sets that to the
# container id, so the published port would not be the panel. The drive-agent
# is not started here: it stays on the Mac host and needs /Volumes.
set -eu
export HOSTNAME=0.0.0.0
export PORT="${PORT:-4317}"
mkdir -p "${SKLAD_DATA_DIR:-/var/lib/sklad}"
exec "$@"
