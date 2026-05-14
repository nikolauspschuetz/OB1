# Tiny single-process importer service. Stdlib-only Python; no
# package install beyond the base image. Bind-mount the host's
# ~/.claude/projects if the Claude Code connector is enabled.
FROM python:3.13-alpine
WORKDIR /app
COPY . /app/integrations/connectors
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV XDG_CACHE_HOME=/var/state
RUN adduser -D -u 1000 importer && mkdir -p /var/state && chown -R importer /var/state
USER importer
# Default to --watch mode. Override at run time (e.g. once+source for
# manual backfills) with: docker run … --once --source slack
ENTRYPOINT ["python3", "-m", "integrations.connectors"]
CMD ["--watch"]
