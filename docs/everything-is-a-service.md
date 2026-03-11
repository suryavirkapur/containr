# Everything is a service

This document defines the target architecture for containr.

The core principle is that every deployable, manageable unit is a Service.

- Web apps, workers, cron jobs are services.
- Managed databases (postgres/redis/etc.) are services.
- Managed queues (rabbitmq/etc.) are services.
- "apps" and "projects" are legacy concepts and will be removed.

## Goals

- One canonical resource model: Service.
- One canonical API surface: `/api/services/*`.
- One canonical UI information architecture: services list + service detail.
- Remove duplication across apps/projects/databases/queues codepaths.
- Make it easy to add a new service kind without duplicating:
  - CRUD
  - runtime actions
  - deployments
  - observability

## Current state (observed)

Backend:

- `crates/containr-api/src/server.rs` registers multiple parallel route families:
  - `/api/apps/*`
  - `/api/projects/*`
  - `/api/databases/*`
  - `/api/queues/*`
  - `/api/services/*` (already exists but is not the sole canonical surface)

- `crates/containr-common` already contains "service-shaped" primitives:
  - `models::ServiceType` for render-style categories (web_service, postgres, rabbitmq, etc.)
  - `service_inventory::ServiceInventoryItem` which represents a unified inventory entry

Frontend:

- `web/src/pages` still contains type-specific pages (`Databases`, `Queues`, etc.) alongside newer unified services views.
- The UI repeats the same patterns for:
  - loading/error
  - action pending state
  - refetch
  - copy-to-clipboard feedback

## Target domain model

### Service

A Service is the canonical persistent entity. At minimum it must represent:

- identity: id, owner_id
- naming and grouping: name, optional group_id (network boundary)
- kind/category:
  - `kind` (high-level): app | database | queue | worker | cron
  - `service_type` (existing enum `containr_common::models::ServiceType`) for specific categories
- runtime spec: image/build, ports, env, mounts, replicas, schedule
- routing spec: public_http, domains, internal_host/network
- status: desired_instances, running_instances, health, latest deployment

Notes:

- `ServiceInventoryItem` already captures most fields we want to display for list views.
- The persistent "spec" model should be normalized so that service kinds differ by optional sub-specs,
  not by entirely separate top-level entities.

### Group

A Group is a network boundary only:

- Services in the same group share an internal network.
- Services in different groups are isolated at the network layer.

If the current codebase still stores `project_id` or `project_name`, those become optional
legacy fields during migration and are removed once the UI and persistence are migrated.

## Target API surface

Canonical routes:

- `GET /api/services`
- `POST /api/services`
- `GET /api/services/:id`
- `PATCH /api/services/:id`
- `DELETE /api/services/:id`

Runtime actions:

- `POST /api/services/:id/actions/:action`
  - actions include: start | stop | restart | redeploy | backup | restore (kind-dependent)

Logs and runtime introspection:

- `GET /api/services/:id/logs`
- `GET /api/services/:id/runtime/containers`
- `POST /api/services/:id/runtime/exec` (terminal)

Deployments:

- `GET /api/services/:id/deployments`
- `POST /api/services/:id/deployments`

Non-goals:

- No long-term compatibility surface for `/api/apps`, `/api/projects`, `/api/databases`, `/api/queues`.
  Those endpoints will be removed after UI migration.

## Migration plan

This refactor will be implemented in phases with small commits.

### Phase 1: Define the model and endpoints

- Document the target (this doc).
- Add a service layer boundary in the backend.

### Phase 2: Backend canonicalization

- Implement `/api/services/*` as the canonical surface backed by the service layer.
- Compose routers by domain modules (avoid a single mega router file).

### Phase 3: UI migration

- Update the Solid UI to use `/api/services` as the primary data source.
- Consolidate into services list + service detail.
- Remove type-specific pages or convert them into filtered services views.

### Phase 4: Remove legacy surfaces

- Delete backend handlers/routes for:
  - `/api/apps/*`
  - `/api/projects/*`
  - `/api/databases/*`
  - `/api/queues/*`

- Remove unused legacy models and frontend routes.

## Removal checklist

Backend:

- No route registrations for `/api/apps`, `/api/projects`, `/api/databases`, `/api/queues`.
- No handler modules for those legacy resource families.
- No persistence trees/tables that are only used by legacy entities.

Frontend:

- No pages or links that navigate to legacy resource routes.
- All create/edit/detail flows are service-based.

Build:

- `cargo test` passes for the workspace.
- `pnpm -C web build` passes.
