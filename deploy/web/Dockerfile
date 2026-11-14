ARG IMMICH_SERVER_IMAGE
FROM ${IMMICH_SERVER_IMAGE}

ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/zdaiwmm/mjora-server" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY www/ /build/www/
