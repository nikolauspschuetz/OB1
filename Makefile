# Open Brain — local Docker Compose operations.
# Run `make help` for the target list.
#
# Profiles let you run multiple isolated stacks side-by-side, each with its
# own Postgres volume, ports, MCP access key, and brain identity:
#   make up                        # default profile (.env, project ob1)
#   make up PROFILE=work           # .env.work, project ob1-work
#   make up PROFILE=personal       # .env.personal, project ob1-personal
# `make profile-init NAME=foo` bootstraps a new profile.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Profile resolution: empty PROFILE = default (.env, project ob1).
PROFILE ?=
ifeq ($(strip $(PROFILE)),)
ENV_FILE := .env
PROJECT  := ob1
PROFILE_LABEL := default
else
ENV_FILE := .env.$(PROFILE)
PROJECT  := ob1-$(PROFILE)
PROFILE_LABEL := $(PROFILE)
endif

# Load the profile's env file if present so its values are available to recipes.
ifneq (,$(wildcard $(ENV_FILE)))
include $(ENV_FILE)
export
endif

# Optional compose-profile flags. Stackable.
#   BACKEND=bedrock  → enables the litellm gateway
#   WORKER=1         → enables the entity-extraction worker (server/worker.ts)
#   DASHBOARD=1      → enables the Next.js dashboard (dashboard/)
#   GATEWAY=1        → layers docker-compose.gateway.yml so the dashboard
#                      joins the shared Traefik network ob1_gateway and
#                      advertises its subdomain route. Requires
#                      `make gateway-up` first (one-time per host).
BACKEND ?=
WORKER ?=
DASHBOARD ?=
GATEWAY ?=
IMPORTERS ?=
SLACKBOT ?=
COMPOSE_PROFILES :=
ifeq ($(BACKEND),bedrock)
COMPOSE_PROFILES += --profile bedrock
endif
ifneq ($(WORKER),)
COMPOSE_PROFILES += --profile worker
endif
ifneq ($(DASHBOARD),)
COMPOSE_PROFILES += --profile dashboard
endif
ifneq ($(IMPORTERS),)
COMPOSE_PROFILES += --profile importers
endif
ifneq ($(SLACKBOT),)
COMPOSE_PROFILES += --profile slackbot
endif
COMPOSE_FILES := -f docker-compose.yml
ifneq ($(GATEWAY),)
COMPOSE_FILES += -f docker-compose.gateway.yml
endif

# Base domain Traefik routes against. Each profile becomes
# <profile>.<OB1_BASE_DOMAIN>. *.localhost auto-resolves to 127.0.0.1
# in Chrome/Firefox/Safari; override for real DNS (e.g. ob1.test).
OB1_BASE_DOMAIN ?= ob1.localhost

COMPOSE   ?= docker compose -p $(PROJECT) --env-file $(ENV_FILE) $(COMPOSE_FILES) $(COMPOSE_PROFILES)

# Helper script that prints "name=url,name=url" for sibling profiles
# (excluding the active one) whose env file declares a DASHBOARD_PORT.
# Used by recipes to populate OB1_PEER_PROFILES so the dashboard nav
# can render a Slack-style profile switcher.
PEER_PROFILES_CMD = ./ci/peer-profiles.sh $(PROFILE_LABEL)
DB_USER   ?= openbrain
DB_NAME   ?= openbrain
MCP_PORT  ?= 8000
MCP_HOST  ?= http://localhost:$(MCP_PORT)

# Smoke targets pin to a fixed throwaway profile (ob1-smoke / .env.smoke) so
# they never touch real profile state. Generated from ci/.env.ci, which uses
# unusual ports (18000/65432) so smoke can run alongside any live profile.
COMPOSE_SMOKE := docker compose -p ob1-smoke --env-file .env.smoke
SMOKE_HOST    := http://localhost:18000

# Bedrock smoke uses ports 18010/65433 + LiteLLM 4000 + mock-openai 4001.
COMPOSE_SMOKE_BEDROCK := docker compose -p ob1-smoke-bedrock --env-file .env.smoke-bedrock --profile ci-bedrock
SMOKE_BEDROCK_HOST    := http://localhost:18010

.PHONY: help env doctor up down restart build rebuild logs ps psql verify urls rotate-key setup clean nuke smoke smoke-webhook smoke-bedrock metrics obctl-install ci ci-env ci-env-bedrock fmt-check lint check-env-drift quality profile-init profile-list profile-down profiles up-all down-all gateway-up gateway-down gateway-status claude-link claude-link-self slack-join-all install-hooks uninstall-hooks switch-embedding-dim verify-bedrock bedrock-list-models backfill-embeddings import-gh-token

help: ## Show this help
	@printf "Open Brain — local Docker Compose\n\n"
	@printf "Usage: make <target>\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

env: ## Bootstrap the active profile's env file from .env.example and generate MCP_ACCESS_KEY
	@echo "Profile: $(PROFILE_LABEL) (env file: $(ENV_FILE))"
	@if [ ! -f $(ENV_FILE) ]; then \
	  cp .env.example $(ENV_FILE); \
	  echo "Created $(ENV_FILE) from .env.example"; \
	fi
	@if grep -qE '^MCP_ACCESS_KEY=$$' $(ENV_FILE); then \
	  KEY=$$(openssl rand -hex 32); \
	  awk -v k="$$KEY" '/^MCP_ACCESS_KEY=$$/{print "MCP_ACCESS_KEY="k; next} {print}' $(ENV_FILE) > $(ENV_FILE).tmp && mv $(ENV_FILE).tmp $(ENV_FILE); \
	  echo "Generated MCP_ACCESS_KEY"; \
	fi
	@if grep -qE '^DB_PASSWORD=$$' $(ENV_FILE); then \
	  echo "WARNING: DB_PASSWORD is empty in $(ENV_FILE) — set it before \`make up\`"; \
	fi
	@if grep -qE '^EMBEDDING_API_KEY=$$' $(ENV_FILE); then \
	  echo "WARNING: EMBEDDING_API_KEY is empty in $(ENV_FILE) — set it before \`make up\`"; \
	fi
	@if [ -n "$(PROFILE)" ]; then \
	  echo "NOTE: profile '$(PROFILE)' uses default ports from .env.example. Edit $(ENV_FILE) to pick non-conflicting MCP_PORT and DB_PORT before \`make up PROFILE=$(PROFILE)\`."; \
	fi

doctor: ## Pre-flight checks (docker, compose, env file, ports, stale supabase dir)
	@echo "Profile: $(PROFILE_LABEL) (env file: $(ENV_FILE), project: $(PROJECT))"
	@echo "Checking docker..."
	@command -v docker >/dev/null 2>&1 || { echo "  docker not found — install Docker Desktop"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "  docker daemon not running — start Docker Desktop"; exit 1; }
	@echo "  docker: $$(docker --version)"
	@echo "Checking docker compose..."
	@$(COMPOSE) version >/dev/null 2>&1 || { echo "  docker compose not available"; exit 1; }
	@echo "  $$($(COMPOSE) version | head -n1)"
	@echo "Checking $(ENV_FILE)..."
	@test -f $(ENV_FILE) || { echo "  $(ENV_FILE) missing — run \`make env$(if $(PROFILE), PROFILE=$(PROFILE),)\`"; exit 1; }
	@grep -qE '^DB_PASSWORD=.+' $(ENV_FILE) || { echo "  DB_PASSWORD is empty in $(ENV_FILE)"; exit 1; }
	@grep -qE '^MCP_ACCESS_KEY=.+' $(ENV_FILE) || { echo "  MCP_ACCESS_KEY is empty in $(ENV_FILE) — run \`make env$(if $(PROFILE), PROFILE=$(PROFILE),)\`"; exit 1; }
	@grep -qE '^EMBEDDING_API_KEY=.+' $(ENV_FILE) || { echo "  EMBEDDING_API_KEY is empty in $(ENV_FILE)"; exit 1; }
	@echo "  $(ENV_FILE): ok"
	@echo "Checking ports..."
	@! lsof -nP -iTCP:$(MCP_PORT) -sTCP:LISTEN >/dev/null 2>&1 || echo "  WARNING: port $(MCP_PORT) is already in use"
	@DB_PORT=$${DB_PORT:-55432}; ! lsof -nP -iTCP:$$DB_PORT -sTCP:LISTEN >/dev/null 2>&1 || echo "  WARNING: port $$DB_PORT (DB_PORT) is already in use"
	@echo "Checking for stale ~/supabase folder (the legacy foot-gun)..."
	@test ! -d $$HOME/supabase || echo "  WARNING: ~/supabase exists — only matters if you also use the legacy Supabase CLI flow"
	@echo "All checks passed."

build: ## Build the MCP server image
	$(COMPOSE) build

rebuild: ## Build with --no-cache
	$(COMPOSE) build --no-cache

up: ## Start the stack in the background
	@PEERS=$$($(PEER_PROFILES_CMD) $(OB1_BASE_DOMAIN) $(GATEWAY)); \
	COOKIE_DOMAIN=""; \
	if [ -n "$(GATEWAY)" ]; then COOKIE_DOMAIN=".$(OB1_BASE_DOMAIN)"; fi; \
	AWS_EXPORT=""; \
	if [ "$(BACKEND)" = "bedrock" ]; then \
	  AWS_EXPORT=$$(./ci/export-aws-creds.sh $(ENV_FILE) 2>/dev/null || true); \
	fi; \
	env $$AWS_EXPORT \
	OB1_PROFILE=$(PROFILE_LABEL) \
	OB1_PEER_PROFILES="$$PEERS" \
	OB1_BASE_DOMAIN=$(OB1_BASE_DOMAIN) \
	OB1_COOKIE_DOMAIN="$$COOKIE_DOMAIN" \
	$(COMPOSE) up -d

down: ## Stop the stack (preserves data volume)
	$(COMPOSE) down

restart: ## Restart the MCP server only (db keeps running)
	$(COMPOSE) restart mcp

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

ps: ## Show service status
	$(COMPOSE) ps

psql: ## Open a psql shell against the running db container
	$(COMPOSE) exec db psql -U $(DB_USER) -d $(DB_NAME)

verify: ## Hit /healthz then call MCP tools/list with the access key
	@set -e; \
	echo "→ GET $(MCP_HOST)/healthz"; \
	curl -fsS $(MCP_HOST)/healthz | tee /dev/stderr; echo; \
	echo "→ POST $(MCP_HOST)?key=*** (tools/list)"; \
	curl -fsS -X POST "$(MCP_HOST)?key=$$MCP_ACCESS_KEY" \
	  -H 'Content-Type: application/json' \
	  -H 'Accept: application/json, text/event-stream' \
	  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
	  | head -c 800; echo; \
	echo "OK — MCP server is responding."

urls: ## Print the MCP server URL and connection URL for AI clients
	@echo "Profile:            $(PROFILE_LABEL) (env file: $(ENV_FILE))"
	@echo "MCP Server URL:     $(MCP_HOST)"
	@echo "MCP Connection URL: $(MCP_HOST)?key=$$MCP_ACCESS_KEY"
	@echo "Header alternative: -H 'x-brain-key: $$MCP_ACCESS_KEY'"
	@if [ -n "$(DASHBOARD)" ]; then \
	  DPORT=$$(grep -E '^DASHBOARD_PORT=' $(ENV_FILE) | cut -d= -f2-); \
	  DPORT=$${DPORT:-3000}; \
	  if [ -n "$(GATEWAY)" ]; then \
	    echo "Dashboard URL:      http://$(PROFILE_LABEL).$(OB1_BASE_DOMAIN):$(GATEWAY_PORT) (via gateway)"; \
	    echo "                    http://localhost:$$DPORT (direct, bypasses gateway)"; \
	  else \
	    echo "Dashboard URL:      http://localhost:$$DPORT"; \
	  fi; \
	fi

rotate-key: ## Generate a new MCP_ACCESS_KEY in the active profile's env file and restart the server
	@KEY=$$(openssl rand -hex 32); \
	awk -v k="$$KEY" '/^MCP_ACCESS_KEY=/{print "MCP_ACCESS_KEY="k; next} {print}' $(ENV_FILE) > $(ENV_FILE).tmp && mv $(ENV_FILE).tmp $(ENV_FILE); \
	echo "New MCP_ACCESS_KEY written to $(ENV_FILE)"; \
	$(COMPOSE) up -d mcp; \
	echo "Restarted mcp. Update every AI client with the new connection URL (run \`make urls$(if $(PROFILE), PROFILE=$(PROFILE),)\`)."

setup: env doctor build up verify urls ## One-shot: env → doctor → build → up → verify → urls
	@echo "Open Brain is up. Connect an AI client using the URL above."

clean: ## Stop the stack and remove the data volume (DESTRUCTIVE — confirms first)
	@printf "This will delete the Postgres data volume for profile '$(PROFILE_LABEL)' (project $(PROJECT)). Continue? [y/N] "; \
	read ans; [ "$$ans" = "y" ] || { echo "Aborted."; exit 1; }
	$(COMPOSE) down -v

nuke: ## Stop the stack, remove volumes AND images (full reset; confirms first)
	@printf "This will delete volumes AND built images. Continue? [y/N] "; \
	read ans; [ "$$ans" = "y" ] || { echo "Aborted."; exit 1; }
	$(COMPOSE) down -v --rmi local

smoke: ci-env ## End-to-end smoke test using LLM_MOCK (no LLM credentials, isolated from real profiles)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found — required for obctl. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	@echo "→ booting smoke stack (project=ob1-smoke, port $(SMOKE_HOST))"
	@$(COMPOSE_SMOKE) down -v >/dev/null 2>&1 || true
	@LLM_MOCK=true $(COMPOSE_SMOKE) up -d --build
	@echo "→ waiting for /healthz"
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  if curl -fsS $(SMOKE_HOST)/healthz >/dev/null 2>&1; then break; fi; sleep 1; \
	done
	@curl -fsS $(SMOKE_HOST)/healthz || { echo "  /healthz never came up"; exit 1; }
	@echo
	@SENTENCE="ob1 smoke test sentinel $$(date +%s)"; \
	KEY=$$(grep -E '^MCP_ACCESS_KEY=' .env.smoke | cut -d= -f2-); \
	echo "→ obctl capture \"$$SENTENCE\""; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY capture "$$SENTENCE"; \
	echo; \
	echo "→ obctl search (same sentence, mock embeddings are identity-only)"; \
	OUT=$$(bin/obctl --url=$(SMOKE_HOST) --key=$$KEY search "$$SENTENCE"); \
	echo "$$OUT"; \
	echo "$$OUT" | grep -qF "$$SENTENCE" || { echo "FAIL: capture did not round-trip through search"; exit 1; }; \
	echo; \
	echo "→ obctl list --limit 1"; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY list --limit 1; \
	echo; \
	echo "→ obctl stats"; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY stats; \
	echo; \
	echo "→ ChatGPT-compat search tool"; \
	RAW=$$(curl -fsS -X POST $(SMOKE_HOST)/mcp \
	  -H "x-brain-key: $$KEY" \
	  -H "Accept: application/json, text/event-stream" \
	  -H "Content-Type: application/json" \
	  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"query\":\"$$SENTENCE\"}}}"); \
	echo "$$RAW" | grep -qE 'results.*id.*title.*url' || { echo "FAIL: search tool did not return id/title/url shape"; echo "$$RAW"; exit 1; }; \
	ID=$$(echo "$$RAW" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1); \
	echo "  search returned id=$$ID"; \
	echo "→ ChatGPT-compat fetch tool"; \
	FETCH=$$(curl -fsS -X POST $(SMOKE_HOST)/mcp \
	  -H "x-brain-key: $$KEY" \
	  -H "Accept: application/json, text/event-stream" \
	  -H "Content-Type: application/json" \
	  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"fetch\",\"arguments\":{\"id\":\"$$ID\"}}}"); \
	echo "$$FETCH" | grep -qE 'sentinel' || { echo "FAIL: fetch did not return content"; echo "$$FETCH"; exit 1; }; \
	echo "  fetch returned full document"; \
	echo "→ update_thought tool + attribution_log"; \
	UPDATE=$$(curl -fsS -X POST $(SMOKE_HOST)/mcp \
	  -H "x-brain-key: $$KEY" \
	  -H "Accept: application/json, text/event-stream" \
	  -H "Content-Type: application/json" \
	  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"update_thought\",\"arguments\":{\"id\":\"$$ID\",\"importance\":5,\"actor\":\"smoke-test\"}}}"); \
	echo "$$UPDATE" | grep -qE 'importance_changed|Updated thought' || { echo "FAIL: update_thought response missing success marker"; echo "$$UPDATE"; exit 1; }; \
	echo "  update_thought returned: $$(echo "$$UPDATE" | grep -oE 'Updated thought[^\"]*')"; \
	LOG_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM attribution_log WHERE actor='mcp:smoke-test'" 2>/dev/null); \
	echo "  attribution_log rows for smoke-test actor: $$LOG_COUNT (expect 1)"; \
	[ "$$LOG_COUNT" -ge 1 ] || { echo "FAIL: attribution_log row not written"; exit 1; }
	@echo
	@echo "→ tearing down smoke stack"
	@$(COMPOSE_SMOKE) down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — smoke test passed (capture, search, list, stats, ChatGPT search/fetch, update_thought + attribution_log)."

classify-edges: ## Run the typed-edge classifier batch (requires WORKER=1 stack up). Optional: LIMIT=N MIN_CONF=0.75
	@$(COMPOSE) exec worker deno run --allow-net --allow-env --allow-read /app/classify.ts \
	  --limit $(or $(LIMIT),50) --min-confidence $(or $(MIN_CONF),0.75)

smoke-worker: ci-env ## End-to-end worker test using LLM_MOCK stub (no LLM credentials, exercises entity_extraction_queue → entities → thought_entities → wiki_pages → thought_edges)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found — required for obctl. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	@echo "→ booting smoke stack with WORKER=1 and LLM_MOCK=true"
	@$(COMPOSE_SMOKE) --profile worker down -v >/dev/null 2>&1 || true
	@LLM_MOCK=true WORKER_POLL_MS=1000 MIN_LINKED_FOR_WIKI=1 $(COMPOSE_SMOKE) --profile worker up -d --build
	@echo "→ waiting for /healthz"
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  if curl -fsS $(SMOKE_HOST)/healthz >/dev/null 2>&1; then break; fi; sleep 1; \
	done
	@curl -fsS $(SMOKE_HOST)/healthz >/dev/null || { echo "  /healthz never came up"; exit 1; }
	@KEY=$$(grep -E '^MCP_ACCESS_KEY=' .env.smoke | cut -d= -f2-); \
	STAMP=$$(date +%s); \
	echo "→ obctl capture (2 thoughts with same first word — exercises classifier candidate path)"; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY capture "WorkerTest first sentinel $$STAMP" >/dev/null; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY capture "WorkerTest second sentinel $$STAMP" >/dev/null; \
	echo "→ waiting for worker to drain both rows (up to 30s)"; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  PENDING=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entity_extraction_queue WHERE status <> 'complete'" 2>/dev/null); \
	  if [ "$$PENDING" = "0" ]; then break; fi; sleep 2; \
	done; \
	echo "  pending rows: $$PENDING (expect 0)"; \
	[ "$$PENDING" = "0" ] || { echo "FAIL: worker did not drain queue"; $(COMPOSE_SMOKE) --profile worker logs --tail 60 worker; exit 1; }; \
	echo "→ verifying entities + thought_entities populated (dedup means 2 thoughts → 1 entity)"; \
	ENTITY_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entities" 2>/dev/null); \
	LINK_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM thought_entities" 2>/dev/null); \
	echo "  entities: $$ENTITY_COUNT, thought_entities: $$LINK_COUNT"; \
	[ "$$ENTITY_COUNT" -ge 1 ] || { echo "FAIL: no entities created"; exit 1; }; \
	[ "$$LINK_COUNT" -ge 2 ] || { echo "FAIL: expected >=2 thought_entities (one per thought sharing an entity), got $$LINK_COUNT"; exit 1; }; \
	echo "→ waiting for wiki_pages row (worker spawns wiki.ts on queue drain, up to 30s)"; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  WIKI_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM wiki_pages" 2>/dev/null); \
	  if [ "$$WIKI_COUNT" -ge 1 ]; then break; fi; sleep 2; \
	done; \
	echo "  wiki_pages: $$WIKI_COUNT"; \
	[ "$$WIKI_COUNT" -ge 1 ] || { echo "FAIL: wiki_pages row never appeared"; $(COMPOSE_SMOKE) --profile worker logs --tail 80 worker; exit 1; }; \
	echo "→ verifying wiki content starts with entity heading"; \
	WIKI_TITLE=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT substring(content, 1, 80) FROM wiki_pages LIMIT 1" 2>/dev/null); \
	echo "  first 80 chars: $$WIKI_TITLE"; \
	echo "$$WIKI_TITLE" | grep -qE '^# ' || { echo "FAIL: wiki content does not start with # heading"; exit 1; }; \
	echo "→ verifying worker log contains processing line"; \
	$(COMPOSE_SMOKE) --profile worker logs --tail 50 worker 2>&1 | grep -qE 'Processing |Done ' || { echo "FAIL: worker log missing processing line"; $(COMPOSE_SMOKE) --profile worker logs --tail 60 worker; exit 1; }; \
	echo "→ running typed-edge classifier (LLM_MOCK emits a related_to edge per candidate pair)"; \
	$(COMPOSE_SMOKE) --profile worker exec -T worker deno run --allow-net --allow-env --allow-read /app/classify.ts --limit 20 --min-confidence 0.5 || { echo "FAIL: classifier exited non-zero"; exit 1; }; \
	echo "→ verifying thought_edges row created"; \
	EDGE_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM thought_edges" 2>/dev/null); \
	echo "  thought_edges: $$EDGE_COUNT"; \
	[ "$$EDGE_COUNT" -ge 1 ] || { echo "FAIL: classifier did not write a thought_edges row"; exit 1; }; \
	echo "→ exercising merge_entities tool (create second entity, then merge)"; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY capture "SecondEntity sentinel $$STAMP" >/dev/null; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
	  COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entities" 2>/dev/null); \
	  if [ "$$COUNT" -ge 2 ]; then break; fi; sleep 2; \
	done; \
	IDS=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM entities" 2>/dev/null); \
	SRC=$$(echo $$IDS | cut -d, -f1); TGT=$$(echo $$IDS | cut -d, -f2); \
	echo "  merging source=$$SRC into target=$$TGT"; \
	curl -fsS -X POST $(SMOKE_HOST)/mcp \
	  -H "x-brain-key: $$KEY" \
	  -H "Accept: application/json, text/event-stream" \
	  -H "Content-Type: application/json" \
	  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"merge_entities\",\"arguments\":{\"source_id\":$$SRC,\"target_id\":$$TGT}}}" \
	  | grep -qE '"merged"|Merged entity' || { echo "FAIL: merge_entities response missing success marker"; exit 1; }; \
	echo "→ verifying merge effects"; \
	REMAINING=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entities WHERE id = $$SRC" 2>/dev/null); \
	BLOCKED=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entity_blocklist WHERE reason = 'merged'" 2>/dev/null); \
	LOG=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM consolidation_log WHERE operation = 'entity_merge'" 2>/dev/null); \
	echo "  source entity remaining: $$REMAINING (expect 0)"; \
	echo "  entity_blocklist 'merged' rows: $$BLOCKED (expect 1)"; \
	echo "  consolidation_log entity_merge rows: $$LOG (expect 1)"; \
	[ "$$REMAINING" = "0" ] || { echo "FAIL: source entity not deleted"; exit 1; }; \
	[ "$$BLOCKED" -ge 1 ] || { echo "FAIL: blocklist row not created"; exit 1; }; \
	[ "$$LOG" -ge 1 ] || { echo "FAIL: audit log not written"; exit 1; }
	@echo
	@echo "→ tearing down smoke-worker stack"
	@$(COMPOSE_SMOKE) --profile worker down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — smoke-worker passed (worker → wiki → thought_edges → merge_entities all exercised)."

metrics: ## Curl /metrics on the running server (Prometheus text format)
	@if [ -n "$$METRICS_TOKEN" ]; then \
	  curl -fsS -H "Authorization: Bearer $$METRICS_TOKEN" $(MCP_HOST)/metrics; \
	else \
	  curl -fsS $(MCP_HOST)/metrics; \
	fi

smoke-webhook: ci-env ## End-to-end GitHub webhook test (LLM_MOCK + synthetic deliveries, isolated)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found — required for obctl. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	@echo "→ booting smoke stack with LLM_MOCK=true + test webhook secrets (project=ob1-smoke, port $(SMOKE_HOST))"
	@$(COMPOSE_SMOKE) down -v >/dev/null 2>&1 || true
	@LLM_MOCK=true \
	  GITHUB_WEBHOOK_SECRET=smoke-webhook-test-secret \
	  LINEAR_WEBHOOK_SECRET=smoke-linear-test-secret \
	  SENTRY_WEBHOOK_SECRET=smoke-sentry-test-secret \
	  GENERIC_WEBHOOK_SECRET=smoke-generic-test-secret \
	  $(COMPOSE_SMOKE) up -d --build
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  if curl -fsS $(SMOKE_HOST)/healthz >/dev/null 2>&1; then break; fi; sleep 1; \
	done
	@curl -fsS $(SMOKE_HOST)/healthz >/dev/null || { echo "  /healthz never came up"; exit 1; }
	@echo "→ ping event"
	@PING_BODY='{"zen":"smoke"}'; \
	SIG=$$(printf '%s' "$$PING_BODY" | openssl dgst -sha256 -hmac 'smoke-webhook-test-secret' -hex | awk '{print $$NF}'); \
	curl -fsS -X POST $(SMOKE_HOST)/webhook/github \
	  -H "X-GitHub-Event: ping" \
	  -H "X-GitHub-Delivery: smoke-test-ping" \
	  -H "X-Hub-Signature-256: sha256=$$SIG" \
	  -H "Content-Type: application/json" \
	  -d "$$PING_BODY" | tee /dev/stderr | grep -q '"message":"pong"' || { echo "FAIL: ping did not return pong"; exit 1; }
	@echo
	@echo "→ pull_request.closed (merged) event"
	@PR_BODY='{"action":"closed","pull_request":{"merged":true,"number":42,"title":"Add authentication middleware","html_url":"https://github.com/test-org/test-repo/pull/42","user":{"login":"alice"},"additions":120,"deletions":15,"changed_files":7,"merged_at":"2026-05-04T10:00:00Z"},"repository":{"full_name":"test-org/test-repo"}}'; \
	SIG=$$(printf '%s' "$$PR_BODY" | openssl dgst -sha256 -hmac 'smoke-webhook-test-secret' -hex | awk '{print $$NF}'); \
	curl -fsS -X POST $(SMOKE_HOST)/webhook/github \
	  -H "X-GitHub-Event: pull_request" \
	  -H "X-GitHub-Delivery: smoke-test-pr-merged" \
	  -H "X-Hub-Signature-256: sha256=$$SIG" \
	  -H "Content-Type: application/json" \
	  -d "$$PR_BODY" | tee /dev/stderr | grep -q '"captured":true' || { echo "FAIL: pull_request not captured"; exit 1; }
	@echo
	@echo "→ release.published event"
	@REL_BODY='{"action":"published","release":{"tag_name":"v1.2.3","html_url":"https://github.com/test-org/test-repo/releases/tag/v1.2.3","author":{"login":"bob"},"body":"Initial release. Adds OB1 webhook capture."},"repository":{"full_name":"test-org/test-repo"}}'; \
	SIG=$$(printf '%s' "$$REL_BODY" | openssl dgst -sha256 -hmac 'smoke-webhook-test-secret' -hex | awk '{print $$NF}'); \
	curl -fsS -X POST $(SMOKE_HOST)/webhook/github \
	  -H "X-GitHub-Event: release" \
	  -H "X-GitHub-Delivery: smoke-test-release" \
	  -H "X-Hub-Signature-256: sha256=$$SIG" \
	  -H "Content-Type: application/json" \
	  -d "$$REL_BODY" | tee /dev/stderr | grep -q '"captured":true' || { echo "FAIL: release not captured"; exit 1; }
	@echo
	@echo "→ negative test: bad signature must return 401"
	@code=$$(curl -s -o /dev/null -w "%{http_code}" -X POST $(SMOKE_HOST)/webhook/github \
	  -H "X-GitHub-Event: ping" \
	  -H "X-Hub-Signature-256: sha256=deadbeef" \
	  -H "Content-Type: application/json" -d '{}'); \
	[ "$$code" = "401" ] || { echo "FAIL: expected 401, got $$code"; exit 1; }; \
	echo "  github 401 returned as expected"
	@echo
	@echo "→ Linear: completed issue (HMAC-SHA-256 in linear-signature header, no prefix)"
	@LIN_BODY='{"action":"update","type":"Issue","data":{"identifier":"ENG-42","title":"Migrate auth to JWT","url":"https://linear.app/team/issue/ENG-42","state":{"type":"completed","name":"Done"},"assignee":{"name":"alice","email":"alice@example.com"},"completedAt":"2026-05-06T10:00:00Z"}}'; \
	SIG=$$(printf '%s' "$$LIN_BODY" | openssl dgst -sha256 -hmac 'smoke-linear-test-secret' -hex | awk '{print $$NF}'); \
	curl -fsS -X POST $(SMOKE_HOST)/webhook/linear \
	  -H "linear-signature: $$SIG" \
	  -H "Content-Type: application/json" \
	  -d "$$LIN_BODY" | tee /dev/stderr | grep -q '"captured":true' || { echo "FAIL: Linear capture failed"; exit 1; }
	@echo
	@echo "→ Linear: bad signature must return 401"
	@code=$$(curl -s -o /dev/null -w "%{http_code}" -X POST $(SMOKE_HOST)/webhook/linear \
	  -H "linear-signature: deadbeef" -H "Content-Type: application/json" -d '{}'); \
	[ "$$code" = "401" ] || { echo "FAIL: linear expected 401, got $$code"; exit 1; }; \
	echo "  linear 401 returned as expected"
	@echo
	@echo "→ Sentry: resolved issue"
	@SEN_BODY='{"action":"resolved","data":{"issue":{"title":"ZeroDivisionError in /api/payments","shortId":"BACKEND-2K","permalink":"https://sentry.io/issues/123","culprit":"checkout.handlers.charge","count":"42","project":{"slug":"backend"}}}}'; \
	SIG=$$(printf '%s' "$$SEN_BODY" | openssl dgst -sha256 -hmac 'smoke-sentry-test-secret' -hex | awk '{print $$NF}'); \
	curl -fsS -X POST $(SMOKE_HOST)/webhook/sentry \
	  -H "sentry-hook-signature: $$SIG" \
	  -H "Content-Type: application/json" \
	  -d "$$SEN_BODY" | tee /dev/stderr | grep -q '"captured":true' || { echo "FAIL: Sentry capture failed"; exit 1; }
	@echo
	@echo "→ Sentry: bad signature must return 401"
	@code=$$(curl -s -o /dev/null -w "%{http_code}" -X POST $(SMOKE_HOST)/webhook/sentry \
	  -H "sentry-hook-signature: deadbeef" -H "Content-Type: application/json" -d '{}'); \
	[ "$$code" = "401" ] || { echo "FAIL: sentry expected 401, got $$code"; exit 1; }; \
	echo "  sentry 401 returned as expected"
	@echo
	@echo "→ Generic: capture via Bearer auth"
	@curl -fsS -X POST $(SMOKE_HOST)/webhook/generic \
	  -H "Authorization: Bearer smoke-generic-test-secret" \
	  -H "Content-Type: application/json" \
	  -d '{"content":"Generic webhook payload from smoke","metadata":{"topics":["smoke","generic"]}}' \
	  | tee /dev/stderr | grep -q '"captured":true' || { echo "FAIL: generic capture failed"; exit 1; }
	@echo
	@echo "→ Generic: missing Authorization must return 401"
	@code=$$(curl -s -o /dev/null -w "%{http_code}" -X POST $(SMOKE_HOST)/webhook/generic \
	  -H "Content-Type: application/json" -d '{"content":"x"}'); \
	[ "$$code" = "401" ] || { echo "FAIL: generic expected 401, got $$code"; exit 1; }; \
	echo "  generic 401 returned as expected"
	@echo
	@echo "→ verify rows in the database via obctl"
	@KEY=$$(grep -E '^MCP_ACCESS_KEY=' .env.smoke | cut -d= -f2-); \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY list --topic pr-merged --limit 5; \
	echo; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY list --topic release --limit 5
	@echo
	@echo "→ scrape /metrics and assert counters reflect the run"
	@METRICS=$$(curl -fsS $(SMOKE_HOST)/metrics); \
	echo "$$METRICS" | grep -E '^ob1_(captures|webhook_deliveries|embedding_requests)_total' | head -20; \
	echo "$$METRICS" | grep -qE '^ob1_captures_total\{source="github_webhook"\} [2-9]' || { echo "FAIL: captures source=github_webhook < 2"; exit 1; }; \
	echo "$$METRICS" | grep -qE '^ob1_webhook_deliveries_total\{event="pull_request",outcome="captured"\} 1' || { echo "FAIL: pr captured count != 1"; exit 1; }; \
	echo "$$METRICS" | grep -qE '^ob1_webhook_deliveries_total\{event="release",outcome="captured"\} 1' || { echo "FAIL: release captured count != 1"; exit 1; }; \
	echo "$$METRICS" | grep -qE '^ob1_webhook_deliveries_total\{event="ping",outcome="invalid_signature"\} 1' || { echo "FAIL: bad-sig count != 1"; exit 1; }; \
	echo "  metrics assertions passed"
	@echo
	@echo "→ tearing down smoke stack"
	@$(COMPOSE_SMOKE) down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — webhook+metrics smoke passed (ping, PR/release captured, bad-sig 401, metrics counters)."

fmt-check: ## Verify deno fmt has been applied (fails on drift)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	deno fmt --check server/ bin/obctl

lint: ## Run deno lint on server and obctl
	@command -v deno >/dev/null 2>&1 || { echo "deno not found. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	deno lint server/ bin/obctl

check-env-drift: ## Verify .env.example documents every env var the server reads
	@./ci/check-env-drift.sh

quality: fmt-check lint check-env-drift ## Run all cheap quality gates (fmt + lint + env drift)
	@echo "OK — quality gates passed."

ci-env: ## Write a stub .env.smoke for CI / smoke targets (does NOT touch your real .env)
	@cp ci/.env.ci .env.smoke
	@echo "Wrote .env.smoke from ci/.env.ci (LLM_MOCK=true, port $(SMOKE_HOST); not for real use)"

ci-env-bedrock: ## Write a stub .env.smoke-bedrock for the Bedrock CI smoke
	@cp ci/.env.ci-bedrock .env.smoke-bedrock
	@echo "Wrote .env.smoke-bedrock from ci/.env.ci-bedrock (LLM_MOCK=false, mocked LiteLLM upstream)"

ci: quality smoke smoke-worker smoke-webhook smoke-bedrock ## Run the full CI sequence locally (quality + smoke + smoke-worker + smoke-webhook + smoke-bedrock)
	@echo
	@echo "OK — full CI sequence passed locally."

smoke-bedrock: ci-env-bedrock ## Validate Bedrock-via-LiteLLM with a mock OpenAI upstream (no AWS creds)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found — required for obctl. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	@echo "→ booting bedrock smoke stack (project=ob1-smoke-bedrock, mcp=$(SMOKE_BEDROCK_HOST), litellm=:4000, mock-openai=:4001)"
	@$(COMPOSE_SMOKE_BEDROCK) down -v >/dev/null 2>&1 || true
	@$(COMPOSE_SMOKE_BEDROCK) up -d --build
	@echo "→ waiting for mcp /healthz"
	@for i in $$(seq 1 40); do \
	  if curl -fsS $(SMOKE_BEDROCK_HOST)/healthz >/dev/null 2>&1; then break; fi; sleep 1; \
	done
	@curl -fsS $(SMOKE_BEDROCK_HOST)/healthz || { echo "  /healthz never came up"; exit 1; }
	@echo
	@echo "→ waiting for litellm /health/liveliness (cold boot can take 30+ seconds)"
	@for i in $$(seq 1 90); do \
	  if curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1; then echo "  ready after $${i}s"; break; fi; sleep 1; \
	done
	@curl -fsS http://localhost:4000/health/liveliness || { echo "  litellm never came up"; $(COMPOSE_SMOKE_BEDROCK) logs litellm | tail -30; exit 1; }
	@echo
	@echo "→ confirm mock-openai is reachable"
	@curl -fsS http://localhost:4001/healthz || { echo "  mock-openai not live"; exit 1; }
	@echo
	@SENTENCE="ob1 bedrock smoke sentinel $$(date +%s)"; \
	KEY=$$(grep -E '^MCP_ACCESS_KEY=' .env.smoke-bedrock | cut -d= -f2-); \
	echo "→ obctl capture (round-trips through MCP → LiteLLM → mock-openai)"; \
	bin/obctl --url=$(SMOKE_BEDROCK_HOST) --key=$$KEY capture "$$SENTENCE"; \
	echo; \
	echo "→ obctl search (proves embedding came back from mock and was stored)"; \
	OUT=$$(bin/obctl --url=$(SMOKE_BEDROCK_HOST) --key=$$KEY search "$$SENTENCE"); \
	echo "$$OUT"; \
	echo "$$OUT" | grep -qF "$$SENTENCE" || { echo "FAIL: bedrock-routed capture did not round-trip through search"; exit 1; }; \
	echo "$$OUT" | grep -q "mock-bedrock" || { echo "FAIL: metadata.topics didn't include the mock-openai stub topic 'mock-bedrock'"; exit 1; }
	@echo
	@echo "→ tearing down bedrock smoke stack"
	@$(COMPOSE_SMOKE_BEDROCK) down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — bedrock smoke passed (MCP → LiteLLM → mock-openai → DB round-trip)."

obctl-install: ## Install obctl on PATH via `deno install` (requires deno on host)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	deno install --global -f --allow-net --allow-env --allow-read -n obctl bin/obctl
	@echo "Installed obctl to $$(command -v obctl 2>/dev/null || echo \"\$$HOME/.deno/bin/obctl\")"
	@echo "Make sure \$$HOME/.deno/bin is on your PATH."

profile-init: ## Bootstrap a new profile: make profile-init NAME=foo
	@test -n "$(NAME)" || { echo "Usage: make profile-init NAME=<name>"; exit 1; }
	@case "$(NAME)" in smoke|ci) echo "ERROR: '$(NAME)' is reserved for the smoke/CI flow"; exit 1;; esac
	@$(MAKE) PROFILE=$(NAME) env

profile-list: ## List known profiles (.env files) and their running status
	@FILES=$$(ls .env .env.* 2>/dev/null | sort -u); \
	count=0; \
	echo "Profile          Env file              Project              Status"; \
	echo "---------------- --------------------- -------------------- ----------"; \
	for f in $$FILES; do \
	  test -f "$$f" || continue; \
	  case "$$f" in \
	    .env)                 label=default;     project=ob1 ;; \
	    .env.example)         continue ;; \
	    .env.smoke)           continue ;; \
	    .env.smoke-bedrock)   continue ;; \
	    .env.smoke-*)         continue ;; \
	    *)                    label=$${f#.env.}; project=ob1-$$label ;; \
	  esac; \
	  if docker compose -p $$project ps -q 2>/dev/null | grep -q .; then status=running; else status="not running"; fi; \
	  printf "%-16s %-21s %-20s %s\n" "$$label" "$$f" "$$project" "$$status"; \
	  count=$$((count+1)); \
	done; \
	if [ $$count -eq 0 ]; then \
	  echo "(none)"; \
	  echo; \
	  echo "Bootstrap one with:"; \
	  echo "  make env                       # default profile (.env, project ob1)"; \
	  echo "  make profile-init NAME=work    # named profile (.env.work, project ob1-work)"; \
	fi

profile-down: ## Stop a specific profile: make profile-down NAME=foo
	@test -n "$(NAME)" || { echo "Usage: make profile-down NAME=<name>"; exit 1; }
	@$(MAKE) PROFILE=$(NAME) down

profiles: profile-list ## Alias for `profile-list`

GATEWAY_PORT ?= 3010
GATEWAY_TRAEFIK_PORT ?= 8088

gateway-up: ## Start the single-entrypoint Traefik gateway on $GATEWAY_PORT (default 3000)
	@echo "→ creating shared docker network ob1_gateway (idempotent)"
	@docker network inspect ob1_gateway >/dev/null 2>&1 || docker network create ob1_gateway >/dev/null
	@echo "→ starting Traefik"
	@GATEWAY_PORT=$(GATEWAY_PORT) GATEWAY_TRAEFIK_PORT=$(GATEWAY_TRAEFIK_PORT) \
	  docker compose -p ob1-gateway -f gateway/docker-compose.yml up -d
	@echo
	@echo "Gateway is up on http://localhost:$(GATEWAY_PORT)"
	@echo "Traefik dashboard: http://localhost:$(GATEWAY_TRAEFIK_PORT)/"
	@echo
	@echo "Now bring up profiles with GATEWAY=1 so they advertise routes:"
	@echo "  GATEWAY=1 DASHBOARD=1 WORKER=1 make up PROFILE=personal"
	@echo "  GATEWAY=1 DASHBOARD=1 WORKER=1 make up PROFILE=tech-screen"
	@echo
	@echo "Then open http://<profile>.$(OB1_BASE_DOMAIN):$(GATEWAY_PORT)"

gateway-down: ## Stop Traefik and remove the shared network
	@docker compose -p ob1-gateway -f gateway/docker-compose.yml down 2>/dev/null || true
	@docker network rm ob1_gateway 2>/dev/null || true
	@echo "Gateway stopped. Profile stacks themselves are untouched."

claude-link: ## Wire a repo's Claude Code to a profile's brain: make claude-link PROFILE=tech-screen TARGET=~/github.com/tech-screen/SaaS-Tech-Screen
	@test -n "$(TARGET)" || { echo "Usage: make claude-link PROFILE=<profile> TARGET=<path>"; exit 1; }
	@./ci/claude-link.sh $(PROFILE_LABEL) $(TARGET)

claude-link-self: ## Link THIS repo's Claude Code to the active profile (so dogfood sessions are brain-aware)
	@./ci/claude-link.sh $(PROFILE_LABEL) $(CURDIR)

slack-join-all: ## Bulk-join the OB1 Slack bot to every public channel: make slack-join-all PROFILE=linguado [DRY_RUN=1] [EXCLUDE=general,random]
	@python3 -m integrations.connectors.slack_join_all \
	  --env-file $(ENV_FILE) \
	  $(if $(DRY_RUN),--dry-run,) \
	  $(if $(EXCLUDE),--exclude $(EXCLUDE),)

gateway-status: ## Show Traefik state + discovered routes
	@if ! docker ps --format '{{.Names}}' | grep -q '^ob1-gateway$$'; then \
	  echo "Gateway is NOT running. Start with: make gateway-up"; exit 0; \
	fi
	@echo "Gateway: running on http://localhost:$(GATEWAY_PORT)"
	@echo "Traefik dashboard: http://localhost:$(GATEWAY_TRAEFIK_PORT)/"
	@echo
	@echo "Discovered routes:"
	@curl -fsS "http://localhost:$(GATEWAY_TRAEFIK_PORT)/api/http/routers" 2>/dev/null \
	  | python3 -c "import json,sys; rs=json.load(sys.stdin); [print(f'  {r[\"rule\"]:60s} → {r.get(\"service\",\"-\")}') for r in rs if r.get('provider')=='docker']" \
	  || echo "  (no routes discovered — bring up a profile with GATEWAY=1)"

up-all: ## Start every profile that has an env file. DASHBOARD=1 / WORKER=1 still apply.
	@for f in $$(ls .env .env.* 2>/dev/null | sort -u); do \
	  test -f "$$f" || continue; \
	  case "$$f" in \
	    .env)               name="" ;; \
	    .env.example|.env.smoke|.env.smoke-*) continue ;; \
	    *)                  name=$${f#.env.} ;; \
	  esac; \
	  echo "==> $$f"; \
	  $(MAKE) PROFILE=$$name up || exit 1; \
	done

down-all: ## Stop every running ob1-* profile. Safe — only touches stacks with an env file.
	@for f in $$(ls .env .env.* 2>/dev/null | sort -u); do \
	  test -f "$$f" || continue; \
	  case "$$f" in \
	    .env)               name="" ;; \
	    .env.example|.env.smoke|.env.smoke-*) continue ;; \
	    *)                  name=$${f#.env.} ;; \
	  esac; \
	  echo "==> stopping $$f"; \
	  $(MAKE) PROFILE=$$name down 2>/dev/null || true; \
	done

switch-embedding-dim: ## Switch the schema's embedding dim: make switch-embedding-dim N=1024 (DESTRUCTIVE — wipes data)
	@test -n "$(N)" || { echo "Usage: make switch-embedding-dim N=<dim> (e.g. 768, 1024, 1536)"; exit 1; }
	@./ci/switch-embedding-dim.sh "$(N)" "$(PROJECT)" "$(ENV_FILE)"

verify-bedrock: ## Probe AWS Bedrock with the active profile's creds (real AWS, real spend, ~30s)
	@./ci/verify-bedrock.sh "$(ENV_FILE)" "$(BEDROCK_CHAT_MODEL)" "$(BEDROCK_EMBED_MODEL)"

bedrock-list-models: ## Print the AWS account's currently-active Claude + embedding model IDs
	@./ci/bedrock-list-models.sh "$(ENV_FILE)"

backfill-embeddings: ## Re-embed rows with NULL embedding for the active profile's stack. PROFILE=foo to target a profile. LIMIT=100 (max 500).
	@LIMIT=$${LIMIT:-100}; \
	KEY=$$(grep -E '^MCP_ACCESS_KEY=' $(ENV_FILE) | cut -d= -f2-); \
	test -n "$$KEY" || { echo "ERROR: MCP_ACCESS_KEY empty in $(ENV_FILE)"; exit 1; }; \
	echo "→ POST $(MCP_HOST)/admin/backfill-embeddings?limit=$$LIMIT"; \
	curl -fsS -X POST "$(MCP_HOST)/admin/backfill-embeddings?key=$$KEY&limit=$$LIMIT" \
	  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"processed={d[\"processed\"]} succeeded={d[\"succeeded\"]} failed={d[\"failed\"]}"); errs=d.get("errors",[]); print(f"first error: {errs[0]}") if errs else None'

import-gh-token: ## Pull EMBEDDING_API_KEY (GitHub PAT) for PROFILE=foo via the gh.sh wrapper
	@./ci/import-gh-token.sh "$(ENV_FILE)"

install-hooks: ## Install local git hooks (.git-hooks/) — runs make quality on push
	git config core.hooksPath .git-hooks
	@echo "Hooks installed. Pre-push will run \`make quality\` (bypass with git push --no-verify)."

uninstall-hooks: ## Restore git's default .git/hooks/ path
	git config --unset core.hooksPath || true
	@echo "Hooks uninstalled. core.hooksPath is now the git default."
