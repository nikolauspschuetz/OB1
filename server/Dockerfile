FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies first for fast incremental rebuilds
COPY deno.json ./
RUN deno install

COPY index.ts ./
COPY worker.ts ./
COPY wiki.ts ./
COPY classify.ts ./
COPY llm/ ./llm/

# Run as the unprivileged user shipped with the deno image
USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
