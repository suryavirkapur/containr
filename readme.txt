containr
=====

rust-native platform as a service for deploying docker containers with automatic ssl.

alpha release v0.1.14-alpha

quick start
-----------

  # install on a vps (installs docker too)
  curl -fsSL https://github.com/suryavirkapur/containr/releases/latest/download/containr-install-vps.sh | sudo bash

  # or install the binaries manually
  curl -fsSL https://github.com/suryavirkapur/containr/releases/latest/download/containr-linux-amd64.tar.gz | tar xz
  sudo install -m 755 containr /usr/local/bin/containr
  sudo install -m 755 containrctl /usr/local/bin/containrctl

  # generate local config if you are running from source
  ./install.sh

  # run
  sudo containr server

  # client setup
  containrctl init --url http://127.0.0.1:2077 --instance-id local
  containrctl register --email admin@example.com --password password123

dashboard and proxied api live at your configured `base_domain`.
direct api access is available on port 2077 by default.

features
--------

- docker container deployment from github repos
- automatic containerfile/dockerfile detection
- pingora reverse proxy with acme ssl
- websocket passthrough support
- grpc (http/2) passthrough support
- server-sent events (sse) streaming support
- multi-container apps with service dependencies
- environment variables with secret masking
- solidjs dashboard
- websocket live container logs
- managed databases (postgres, mariadb, valkey, qdrant)
- managed queues (rabbitmq)
- unified service inventory and lifecycle api/cli
- storage buckets
- certificate management and renewal
- multiple custom domains per app

system requirements
-------------------

- linux x86_64
- macos is not a supported backend runtime or development target
- docker (containerd runtime, installed by `containr-install-vps.sh`)
- rust 1.75+
- mise
- node 24 (via mise)
- pnpm (via mise)

use a linux machine or vm for backend development and runtime testing.

ports:
- 80 (http proxy)
- 443 (https proxy)
- 2077 (api server)

documentation
-------------

docs/quickstart.txt        5-minute quickstart guide
docs/architecture.txt      system architecture overview
docs/api-reference.txt     complete api documentation
docs/configuration.txt     detailed config options
docs/deployment-guide.txt  production deployment guide
docs/troubleshooting.txt   common issues and solutions

examples
--------

examples/simple-web-app.json     basic single container app
examples/api-with-secrets.json   app with secret env vars
examples/multi-container-app.json  multi-service deployment
examples/websocket-app.json      real-time websocket app
examples/grpc-service.json       grpc service
examples/curl-examples.txt       api usage with curl

project structure
-----------------

  crates/
    containr/              main binary
    containr-api/          axum api server
    containr-runtime/      docker container management
    containr-proxy/        pingora reverse proxy
    containr-common/       shared types and database

  web/                  solidjs frontend
  docs/                 documentation
  examples/             example configurations
  data/                 runtime storage (database, certs)

building from source
--------------------

  # backend
  cargo build --release

  # frontend
  mise install
  cd web
  pnpm install
  pnpm build

backend development and runtime testing are only supported on linux.

configuration
-------------

create containr.toml:

  [server]
  host = "0.0.0.0"
  port = 2077

  [database]
  backend = "sqlite"
  path = "./data/containr.db"

  [proxy]
  http_port = 80
  https_port = 443
  base_domain = "example.com"
  public_ip = "203.0.113.10"

  [github]
  client_id = ""
  client_secret = ""
  webhook_secret = ""

  [auth]
  jwt_secret = "change-me-in-production"
  jwt_expiry_hours = 24

  [security]
  encryption_key = "generate-a-secure-key"

  [acme]
  email = "you@example.com"
  certs_dir = "./data/certs"
  staging = true

sqlite is the default backend for fresh installs.
use ./install.sh to generate config with random secrets.

release flow
------------

build and publish a github release with the bundled binaries and vps installer:

  scripts/release-gh.sh

the release script builds `containr` and `containrctl`, creates
`dist/containr-linux-amd64.tar.gz`, writes a sha256 file, and publishes a
prerelease automatically when the version contains `alpha`, `beta`, or `rc`.

docker-backed backend e2e coverage lives in:

  scripts/e2e-services.sh

dns setup
---------

point your base domain and wildcard to your server:

  your-domain.com     A     your-server-ip
  *.your-domain.com   A     your-server-ip

dashboard: your-domain.com
primary app route: app-name.your-domain.com
service route: service-name.app-name.your-domain.com

api endpoints
-------------

auth:
  POST /api/auth/register         create account
  POST /api/auth/login            login
  GET  /api/auth/github           github oauth start
  GET  /api/auth/github/callback  github oauth callback

apps:
  GET    /api/apps                list apps
  POST   /api/apps                create app
  GET    /api/apps/{id}           get app
  PUT    /api/apps/{id}           update app
  DELETE /api/apps/{id}           delete app
  GET    /api/apps/{id}/metrics   get app metrics

deployments:
  GET  /api/apps/{id}/deployments       list deployments
  POST /api/apps/{id}/deployments       trigger deployment
  GET  /api/apps/{id}/deployments/{id}  get deployment
  GET  /api/apps/{id}/logs/ws           websocket logs

certificates:
  GET  /api/apps/{id}/certificate         ssl status
  POST /api/apps/{id}/certificate/reissue renew ssl

managed services:
  GET            /api/services           list unified services
  GET            /api/services/{id}      get unified service
  GET            /api/services/{id}/logs get service logs
  POST           /api/services/{id}/start|stop|restart
  DELETE         /api/services/{id}      delete service
  GET/POST       /api/databases          list/create databases
  GET/DELETE     /api/databases/{id}     get/delete database
  POST           /api/databases/{id}/start|stop
  GET/POST       /api/queues             list/create queues
  GET/DELETE     /api/queues/{id}        get/delete queue
  GET/POST       /api/buckets            list/create buckets
  GET/DELETE     /api/buckets/{id}       get/delete bucket

full api documentation: docs/api-reference.txt

deploying an app
----------------

  # create app
  curl -X POST http://localhost:2077/api/apps \
    -H "authorization: bearer $TOKEN" \
    -H "content-type: application/json" \
    -d '{
      "name": "my-app",
      "github_url": "https://github.com/user/repo",
      "branch": "main",
      "port": 3000
    }'

  # trigger deployment
  curl -X POST http://localhost:2077/api/apps/$APP_ID/deployments \
    -H "authorization: bearer $TOKEN"

see examples/curl-examples.txt for more.

cli examples
------------

  containrctl projects list
  containrctl services list
  containrctl services get SERVICE_ID
  containrctl services logs --id SERVICE_ID --tail 200
  containrctl databases proxy --id DB_ID --enabled
  containrctl databases pitr --id DB_ID --enabled
  containrctl databases base-backup --id DB_ID --label baseline
  containrctl databases restore-point --id DB_ID --restore-point stable
  containrctl databases recover --id DB_ID --restore-point stable

contributing
------------

contributions welcome. please follow the coding style in AGENTS.md.

  cargo fmt
  cargo clippy
  cargo test

license
-------

mit
