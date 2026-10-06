# Run TypeScript sources directly; the application requires Node >=22.19.0.
FROM docker.io/library/node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/flue-subagents
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/

# Keep worktrees, checkpoints and the user's caches outside the target checkout.
ENV FLUE_AGENT_DATA_DIR=/data/runs \
    HOME=/data/home
RUN mkdir -p /repo /data/runs /data/home \
    && chown -R node:node /repo /data

USER node
WORKDIR /repo

# podman run supplies the host bind mount and the quoted prompt/CLI options.
ENTRYPOINT ["node", "/opt/flue-subagents/src/cli.ts", "--repo", "/repo"]
