# AGENTS.md — containr

containr context
================

current context:
- ui overhaul complete (0.1.18-alpha): dark-first design system with cr-* css classes, geist font from npm, no border-radius, sidebar-only navigation
- services page: render-style project cards (network group filter) + clean 5-col services table
- service-detail: networking tab (project move + http/domains), app configs tab (env vars, scaling, auto-deploy), deployment tab (version history accordions), logs tab
- unifying all apps, databases, and queues under a single "service" entity.
- moving toward a hybrid platform combining render's easy ui with caprover's full-featured backend.
- redefining "groups" to purely enforce a network boundary rather than strict container or multi-service lifecycle isolation.

pending tasks:
remove
important decisions:
- documentation lives in Markdown (.md) with normal capitalization; prefer README.md + CHANGELOG.md.
- rust format max width to 80, explicitly handle errors without unwrap().
- rely on toml for config.
- use solid.js and tailwind css with flowbite references.

architectural notes:
- full power on the backend: dockerfile support, direct image deployment, persistent data mounts.
- pure network boundary logic: if services are in the same group, they share an internal docker network. otherwise isolated.
