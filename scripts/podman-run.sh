#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo 'Usage: scripts/podman-run.sh REPOSITORY "PROMPT" [agent options...]'
    echo 'Environment: FLUE_PODMAN_IMAGE, FLUE_PODMAN_STATE_DIR, FLUE_PODMAN_ENV_FILE,'
    echo '             FLUE_AGENT_ENDPOINT, FLUE_AGENT_MODEL'
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    usage
    exit 0
fi
if (( $# < 2 )) || [[ ! $2 =~ [^[:space:]] ]]; then
    usage >&2
    exit 2
fi
if [[ ! -d $1 ]]; then
    echo "Repository directory does not exist: $1" >&2
    exit 2
fi
repo=$(cd -- "$1" && pwd -P)
prompt=$2
shift 2

state=${FLUE_PODMAN_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/flue-subagents-podman}
umask 077
mkdir -p -- "$state"
state=$(cd -- "$state" && pwd -P)
if [[ $state == "$repo" || $state == "$repo/"* ]]; then
    echo 'The state directory must be outside the repository.' >&2
    exit 2
fi
# Podman's --mount syntax cannot represent commas in source paths.
if [[ $repo == *,* || $state == *,* ]]; then
    echo 'Repository and state paths must not contain commas.' >&2
    exit 2
fi
mkdir -p -- "$state/home" "$state/runs"
chmod 700 -- "$state"

podman_args=(
    run --rm --init -i --stop-timeout 60
    --userns keep-id
    --user "$(id -u):$(id -g)"
    --mount "type=bind,source=$repo,target=/repo,relabel=private"
    --mount "type=bind,source=$state,target=/data,relabel=private"
)
if [[ -n ${FLUE_PODMAN_ENV_FILE:-} ]]; then
    if [[ ! -f $FLUE_PODMAN_ENV_FILE ]]; then
        echo "Environment file does not exist: $FLUE_PODMAN_ENV_FILE" >&2
        exit 2
    fi
    podman_args+=(--env-file "$FLUE_PODMAN_ENV_FILE")
fi
# Explicit values override an env file; otherwise let the file configure models.
if [[ -n ${FLUE_AGENT_ENDPOINT:-} || -z ${FLUE_PODMAN_ENV_FILE:-} ]]; then
    podman_args+=(-e "FLUE_AGENT_ENDPOINT=${FLUE_AGENT_ENDPOINT:-http://host.containers.internal:8731/v1}")
fi
if [[ -n ${FLUE_AGENT_MODEL:-} || -z ${FLUE_PODMAN_ENV_FILE:-} ]]; then
    podman_args+=(-e "FLUE_AGENT_MODEL=${FLUE_AGENT_MODEL:-halogen/qwen-3.8-flash-next}")
fi

# '--' protects prompts beginning with a dash; options remain separate arguments.
exec podman "${podman_args[@]}" "${FLUE_PODMAN_IMAGE:-flue-subagents}" "$@" -- "$prompt"
