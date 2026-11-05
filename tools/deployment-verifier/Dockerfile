# 공식 이미지의 실제 ARM64 manifest를 고정한다. 외부 package index나 후보 앱을 실행하지 않는다.
FROM docker.io/library/python:3.12-slim-bookworm@sha256:df540bfd30bd380e89a349611ce42aa67bcb542d58c047706616eb6ba2f86a1b AS python
FROM public.ecr.aws/aws-cli/aws-cli@sha256:89743b80682740ba1c751cb2089014a8a0da5ee84a425bb0ff18187cce9ef250 AS awscli
FROM docker.io/library/postgres:16-bookworm@sha256:fb4a48f09f19618d307deb5d153a0b11768d37d5c3592ad0c63737dbe52c78ce
ARG TARGETARCH
COPY --from=python /usr/local/ /usr/local/
COPY --from=awscli /usr/local/aws-cli/ /usr/local/aws-cli/
RUN test "$TARGETARCH" = arm64 && ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws && \
    python3 -c 'import ssl, hashlib, urllib.request, http.cookiejar' && psql --version && aws --version
COPY scripts/deployment-verifier/ /opt/verifier/
RUN PYTHONDONTWRITEBYTECODE=1 python3 -c 'import sys;sys.path.insert(0,"/opt/verifier");import strict_yaml;assert strict_yaml.parse("key: value") == {"key":"value"}'
ENV PYTHONDONTWRITEBYTECODE=1 AWS_PAGER="" HOME=/tmp
USER 10001:10001
ENTRYPOINT ["python3", "/opt/verifier/verify.py"]
CMD []
