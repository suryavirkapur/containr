# znskr - rust-native paas

a platform as a service for deploying docker containers with automatic ssl.

## features

- docker container deployment from github repos
- automatic containerfile/dockerfile detection
- pingora reverse proxy with acme ssl
- websocket passthrough support
- grpc (http/2) passthrough support
- server-sent events (sse) streaming support
- environment variables (with secret masking)
- solidjs dashboard
- websocket live logs
- certificate management

## quick start

```bash
# build
cargo build --release

# run (requires root for port 80/443)
sudo ./target/release/znskr

# or with custom ports
./target/release/znskr --http-port 8080 --https-port 8443 --api-port 3000
```

## config

config is stored in `znskr.toml`:

```toml
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

[acme]
email = ""
certs_dir = "./data/certs"
staging = true
```

## frontend

```bash
cd web
bun install
bun dev
```

## environment variables

apps support environment variables which are passed to containers:

```json
{
  "name": "my-app",
  "github_url": "https://github.com/user/repo",
  "env_vars": [
    { "key": "DATABASE_URL", "value": "postgres://...", "secret": true },
    { "key": "PUBLIC_KEY", "value": "abc123", "secret": false }
  ]
}
```

secret vars are masked in api responses with "********".

## protocol support

the pingora proxy automatically detects and handles:

- **websocket**: upgrade header detection, full duplex streaming
- **grpc**: application/grpc content-type, http/2 protocol negotiation
- **sse**: text/event-stream accept header, disabled buffering

## api endpoints

- POST /api/auth/register - create account
- POST /api/auth/login - login
- GET /api/apps - list apps
- POST /api/apps - create app (with env_vars)
- GET /api/apps/:id - get app
- PUT /api/apps/:id - update app (with env_vars)
- DELETE /api/apps/:id - delete app
- POST /api/apps/:id/deployments - deploy
- GET /api/apps/:id/logs/ws - websocket container logs
- GET /api/apps/:id/certificate - ssl status
- POST /api/apps/:id/certificate/reissue - renew ssl

## requirements

- rust 1.75+
- docker
- bun (for frontend)
