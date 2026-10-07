# AGENTS.md — containr

containr context
================

current context:
- ui rebuilt for caprover parity: design tokens in web/src/index.css (light + dark via the .dark class, small radii), shared primitives in web/src/components/ui, app shell with sidebar, breadcrumbs and a cmd+k command palette in web/src/components/layout
- pages: overview, services, projects, one-click apps (catalog in web/src/lib/catalog/, one module per category or hand-written stack; see docs/one-click-apps.md and run `pnpm test` in web/), storage, monitoring, server (disk cleanup, backup), settings (general, account, users, github, registries)
- service detail tabs: overview, deployments (git/image/upload/dockerfile/webhook/cli deploys + rollback), logs, metrics, environment, networking (domains, https, basic auth, port mappings), storage (volumes + file browser), console (xterm exec), settings
- new endpoints the ui relies on are typed in web/src/api/platform.ts; regenerate web/src/api/schema.d.ts with `pnpm run generate` after api changes
- unifying all apps, databases, and queues under a single "service" entity.
- moving toward a hybrid platform combining render's easy ui with caprover's full-featured backend.
- redefining "groups" to purely enforce a network boundary rather than strict container or multi-service lifecycle isolation.

pending tasks:
remove
important decisions:
- documentation lives in Markdown (.md) with normal capitalization; prefer README.md + CHANGELOG.md.
- rust format max width to 80, explicitly handle errors without unwrap().
- rely on toml for config.
- no openssl: tls is rustls with the ring provider everywhere (installed as the process default in main); release binaries are static musl builds.
- use solid.js and tailwind css v4; icons from lucide-solid deep imports (lucide-solid/icons/<name>), terminal via @xterm/xterm.
- ui copy is sentence case; buttons say what they do ("Deploy image", "Save changes").

architectural notes:
- full power on the backend: dockerfile support, direct image deployment, persistent data mounts.
- pure network boundary logic: if services are in the same group, they share an internal docker network. otherwise isolated.
