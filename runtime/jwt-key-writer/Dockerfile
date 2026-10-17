# 2026-10-17 Docker Hub의 linux/arm64 manifest digest를 확인했다.
FROM node:24-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5
WORKDIR /app
COPY package.json package-lock.json ./
RUN test "$(node -p process.arch)" = arm64 && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY index.mjs cli.mjs sdk.mjs ./
# task별 volume의 최초 소유권 설정과 UID 10001 읽기 검사를 위해서만 root로 실행한다.
USER 0:0
ENTRYPOINT ["node", "--max-old-space-size=64", "/app/cli.mjs"]
