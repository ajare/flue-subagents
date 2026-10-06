#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    echo 'Usage: scripts/podman-build.sh [podman build options...]'
    echo 'FLUE_PODMAN_IMAGE sets the image tag (default: flue-subagents).'
    exit 0
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec podman build --tag "${FLUE_PODMAN_IMAGE:-flue-subagents}" "$@" "$project_dir"
