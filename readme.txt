znskr
=====

rust-native platform as a service for deploying docker containers with automatic ssl.

alpha release v0.1.0

quick start
-----------

  # install
  cargo install --git https://github.com/suryavirkapur/znskr-paas znskr

  # configure
  ./install.sh

  # run (requires root for ports 80/443)
  sudo znskr

  # or with custom ports
  znskr --http-port 8080 --https-port 8443 --api-port 3000

dashboard available at http://localhost:3000

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
- managed databases (postgres, mysql, redis)
- managed queues (redis, rabbitmq)
- storage buckets
- certificate management and renewal

system requirements
-------------------

- linux x86_64
- docker (containerd runtime)
- rust 1.75+
- bun (for frontend development)

ports:
- 80 (http proxy)
- 443 (https proxy)
- 3000 (api server)

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
    znskr/              main binary
    znskr-api/          axum api server
    znskr-runtime/      docker container management
    znskr-proxy/        pingora reverse proxy
    znskr-common/       shared types and database

  web/                  solidjs frontend
  docs/                 documentation
  examples/             example configurations
  data/                 runtime storage (database, certs)

building from source
--------------------

  # backend
  cargo build --release

  # frontend
  cd web
  bun install
  bun build

configuration
-------------

create znskr.toml:

  [server]
  host = "0.0.0.0"
  port = 3000

  [database]
  path = "./data/znskr.db"

  [proxy]
  http_port = 80
  https_port = 443
  base_domain = "example.com"

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

use ./install.sh to generate config with random secrets.

dns setup
---------

point your base domain and wildcard to your server:

  your-domain.com     A     your-server-ip
  *.your-domain.com   A     your-server-ip

apps are accessible at app-name.your-domain.com.

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
  curl -X POST http://localhost:3000/api/apps \
    -H "authorization: bearer $TOKEN" \
    -H "content-type: application/json" \
    -d '{
      "name": "my-app",
      "github_url": "https://github.com/user/repo",
      "branch": "main",
      "port": 3000
    }'

  # trigger deployment
  curl -X POST http://localhost:3000/api/apps/$APP_ID/deployments \
    -H "authorization: bearer $TOKEN"

see examples/curl-examples.txt for more.

contributing
------------

contributions welcome. please follow the coding style in AGENTS.md.

  cargo fmt
  cargo clippy
  cargo test

license
-------

mit
