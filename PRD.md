# PRD

product requirements document
=============================

product name: containr
intent: a hybrid platform-as-a-service (paas) combining the elegant, intuitive user experience of render with the unopinionated, raw power of caprover.

1. current state & problem definition
---------------------------------------
the current iteration is unified around `/services`, but the underlying concept of "groups" or "projects" has become overly complex and confusing. the platform tries to enforce boundaries that go beyond simple networking, creating a rigid structure for apps, databases, and queues. the user interface feels broken because it forces a top-down "project > service" hierarchy when all the user really wants is to deploy a service quickly. there is friction in how different types of services (web, workers, databases) are managed inside these rigid groups.

2. desired state & core philosophy
------------------------------------
the fundamental unit of the platform is the **service**.
everything is a service: a web app, a worker, a postgres database, a redis cache.

a. rendering the ui (the "render" side)
   - single pane of glass: all services exist in one unified view.
   - ease of use: intuitive creation flows (e.g., click "new service" -> select type -> deploy).
   - beautiful, modern design utilizing the solid.js and tailwind css stack.
   - simple configuration forms where complex docker settings are hidden until requested.

b. raw functionality (the "caprover" side)
   - full power: one-click apps, docker image deployments, raw dockerfiles.
   - unopinionated execution: if it runs in docker, it runs on containr.
   - persistent directories and simple volume mounts without complex pvc logic.
   - easy port mapping, custom domains, and automated ssl via acme.

3. the "group" concept redefined
----------------------------------
groups are simply network boundaries.
- when services are assigned to the same group, they can communicate with each other over a shared internal network (e.g., a web service talking to a database using an internal hostname).
- groups do not create hard container isolation or orchestration boundaries.
- a service can be ungrouped (standalone) or it can join a group.
- destroying a group simply destroys the shared network, not necessarily the containers themselves (or handles their networks gracefully).

4. current parity position vs zaneops (excluding docker swarm integration)
--------------------------------------------------------------------------
containr already covers a meaningful part of the base self-hosted paas surface:
- unified services inventory across app services and managed infrastructure.
- git repository deployments through github app integration and github push webhooks.
- deployment history, deployment logs, service logs, container logs, terminal access, and file browsing.
- custom domains with automated acme certificates.
- managed postgres, redis/valkey, mariadb, qdrant, rabbitmq, and s3-style buckets.

containr is still missing several product workflow features that zaneops exposes:
- multi-environment workflow:
  zaneops has explicit environments and shared environment variables scoped to those environments. containr is intentionally flattening toward "service + network group", so this feature conflicts with the current product direction.
- preview environments:
  there is no pr/mr preview environment model yet.
- gitlab integration:
  github is wired; gitlab is not.
- first-class auto-deploy controls:
  github push deploys exist, but there is no settings surface for toggling auto-deploy, filtering by watch paths, exposing a ci deploy webhook, or cleaning stale queued deployments.
- builder ecosystem:
  containr is dockerfile/image-first. zaneops exposes higher-level builders like nixpacks, railpack, and static-dir flows.
- compose stack import and broader templates:
  containr has a narrow template set and no docker-compose import flow.
- first-class config files:
  mounted volumes and file browsing exist, but there is no managed config-file feature.
- http request logs:
  service logs and container logs exist, but not request-level access logs in the product ui.
- server shell:
  container shell exists; host shell does not.
- review/validate before deploy workflow:
  config editing is still thin, and there is no clear "save config, validate, then deploy" lifecycle in the ui.

5. product direction decision
-----------------------------
containr should not chase zaneops feature-for-feature without preserving its core bet:
- zaneops is more environment-centric.
- containr is service-centric.

that means:
- features that strengthen the service model should move first.
- features that require reintroducing a heavyweight environment/project abstraction should be deferred until there is a clear reason to reverse the current direction.

explicitly:
- service settings, auto-deploy controls, and request logs fit containr now.
- environments and preview environments are valuable, but they require an architectural decision first.

6. prioritized roadmap
----------------------
p0: highest-value gaps that fit the current architecture
- service settings/edit surface:
  add a first-class settings ui and api for repository-backed services. users need to edit build config, runtime config, domains, env vars, rollout strategy, and deploy behavior without recreating the service.
- auto-deploy controls:
  add toggleable auto-deploy, watch paths, ci deploy webhook url, and stale deployment cleanup controls.
- http request logs:
  store and expose service-level request logs in the ui.
- gitlab integration:
  important for parity, but separate from the current implementation batch.

p1: important product depth after p0
- first-class config files.
- builder abstraction (`dockerfile`, `nixpacks`, `railpack`, `static-dir`).
- environments plus shared environment variables.
- preview environments built on top of a real environment model.

p2: useful, but lower roi against current direction
- compose stack import and larger template catalog.
- server shell via web ui.

7. execution plan for the current implementation batch
------------------------------------------------------
build now:
- p0 service settings/edit surface.
- p0 auto-deploy controls.
- p0 http request logs.

defer for now:
- p0 gitlab integration.

implementation rules for this batch:
- editing service configuration should save declarative config first and only affect running workloads when the user deploys.
- proxy routing should follow the active deployed snapshot, not blindly the newest saved config, so settings changes do not break running traffic before deployment.
- auto-deploy must be user-controlled rather than hardwired.
- request logs must be attributable to a specific public service, not just dumped to stdout.

8. technical specifications
---------------------------
- frontend: solid.js with tailwind css (flowbite references).
- backend: rust, tokio async runtime, explicitly handling errors (no unwrap()).
- configuration: all settings stored in toml files.
- metadata & state: agent.txt and changelog.txt maintain context per global rules.

conclusion
------------
containr is about getting out of the user's way. if they want to run a docker container and attach a domain to it, it should take 3 clicks. if they want that container to talk to a database, they put them in the same group. no artificial project boundaries, just pure utility.
