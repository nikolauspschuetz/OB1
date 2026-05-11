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
BACKEND ?=
WORKER ?=
COMPOSE_PROFILES :=
ifeq ($(BACKEND),bedrock)
COMPOSE_PROFILES += --profile bedrock
endif
ifneq ($(WORKER),)
COMPOSE_PROFILES += --profile worker
endif

COMPOSE   ?= docker compose -p $(PROJECT) --env-file $(ENV_FILE) $(COMPOSE_PROFILES)
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

.PHONY: help env doctor up down restart build rebuild logs ps psql verify urls rotate-key setup clean nuke smoke smoke-webhook smoke-bedrock metrics obctl-install ci ci-env ci-env-bedrock fmt-check lint check-env-drift quality profile-init profile-list profile-down install-hooks uninstall-hooks switch-embedding-dim verify-bedrock bedrock-list-models backfill-embeddings import-gh-token

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
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY stats
	@echo
	@echo "→ tearing down smoke stack"
	@$(COMPOSE_SMOKE) down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — smoke test passed (capture, embedding insert, search RPC, list, stats)."

smoke-worker: ci-env ## End-to-end worker test using LLM_MOCK stub (no LLM credentials, exercises entity_extraction_queue → entities → thought_entities)
	@command -v deno >/dev/null 2>&1 || { echo "deno not found — required for obctl. Install: curl -fsSL https://deno.land/install.sh | sh"; exit 1; }
	@echo "→ booting smoke stack with WORKER=1 and LLM_MOCK=true"
	@$(COMPOSE_SMOKE) --profile worker down -v >/dev/null 2>&1 || true
	@LLM_MOCK=true WORKER_POLL_MS=1000 $(COMPOSE_SMOKE) --profile worker up -d --build
	@echo "→ waiting for /healthz"
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
	  if curl -fsS $(SMOKE_HOST)/healthz >/dev/null 2>&1; then break; fi; sleep 1; \
	done
	@curl -fsS $(SMOKE_HOST)/healthz >/dev/null || { echo "  /healthz never came up"; exit 1; }
	@SENTENCE="WorkerTest sentinel $$(date +%s)"; \
	KEY=$$(grep -E '^MCP_ACCESS_KEY=' .env.smoke | cut -d= -f2-); \
	echo "→ obctl capture \"$$SENTENCE\""; \
	bin/obctl --url=$(SMOKE_HOST) --key=$$KEY capture "$$SENTENCE" >/dev/null; \
	echo "→ waiting for worker to drain the queue (up to 30s)"; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	  STATUS=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT status FROM entity_extraction_queue ORDER BY queued_at DESC LIMIT 1" 2>/dev/null); \
	  if [ "$$STATUS" = "complete" ]; then break; fi; sleep 2; \
	done; \
	echo "  queue status: $$STATUS"; \
	[ "$$STATUS" = "complete" ] || { echo "FAIL: worker did not mark queue row complete (last status=$$STATUS)"; $(COMPOSE_SMOKE) --profile worker logs --tail 60 worker; exit 1; }; \
	echo "→ verifying entities + thought_entities populated"; \
	ENTITY_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM entities" 2>/dev/null); \
	LINK_COUNT=$$(docker exec ob1-smoke-db-1 psql -U openbrain -d openbrain -tA -c "SELECT count(*) FROM thought_entities" 2>/dev/null); \
	echo "  entities: $$ENTITY_COUNT, thought_entities: $$LINK_COUNT"; \
	[ "$$ENTITY_COUNT" -ge 1 ] || { echo "FAIL: no entities created"; exit 1; }; \
	[ "$$LINK_COUNT" -ge 1 ] || { echo "FAIL: no thought_entities created"; exit 1; }; \
	echo "→ verifying worker log contains processing line"; \
	$(COMPOSE_SMOKE) --profile worker logs --tail 30 worker 2>&1 | grep -qE 'Processing |Done ' || { echo "FAIL: worker log missing processing line"; $(COMPOSE_SMOKE) --profile worker logs --tail 60 worker; exit 1; }
	@echo
	@echo "→ tearing down smoke-worker stack"
	@$(COMPOSE_SMOKE) --profile worker down -v >/dev/null 2>&1 || true
	@echo
	@echo "OK — smoke-worker passed (queue drained, entities created, thought_entities linked)."

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
