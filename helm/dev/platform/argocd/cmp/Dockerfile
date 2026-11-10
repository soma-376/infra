# repo-server와 별도로 고정 Helm·Node·YAML 의존성을 가진 렌더 전용 이미지다.
FROM docker.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
ARG TARGETARCH
WORKDIR /opt/pulsemetry
COPY package.json package-lock.json toolchain.json install-helm.mjs ./
RUN node install-helm.mjs && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY bin/ ./bin/
RUN mkdir -p /home/argocd/cmp-server/config /home/argocd/cmp-server/plugins && chown -R 999:999 /home/argocd
ENV HOME=/home/argocd
USER 999:999
ENTRYPOINT ["/var/run/argocd/argocd-cmp-server"]
