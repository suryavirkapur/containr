# Containr - PaaS in a single binary (Proxy/SSL/Containers/WebUI in one Binary)

 Written entirely in Rust with the help of Codex.

## Install

On a Linux server with Docker, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/suryavirkapur/containr/main/install.sh | sudo sh -s -- --domain example.com --email you@example.com
```

The script downloads the newest release, writes `/opt/containr/containr.toml` with random secrets and runs containr as a service. It detects systemd, OpenRC, runit, dinit and SysV init; pass `--init` to choose one. Run it again to update: it replaces the binary, keeps the old one as `containr.previous` and restarts the service. It never overwrites the config. Run `install.sh --help` for every option.

Release binaries are static (musl, rustls with ring, no OpenSSL), so the same file runs on any x86-64 or arm64 Linux, glibc or musl. Deploying from git repositories needs `git` on the server.

To manage the service yourself:

```sh
containr service install --init openrc   # or systemd, runit, dinit, sysvinit; default auto
containr service install --print         # show the service files instead of writing them
containr service restart
```

## Updates

Each `v*` tag builds Linux binaries (`containr-linux-amd64`, `containr-linux-arm64`) with a `.sha256` file and publishes them as a GitHub release (`.github/workflows/release.yml`). The tag must match the workspace version in `Cargo.toml`. Tags with a hyphen, like `v0.1.16-alpha`, are published as prereleases.

Admins can check for and install new releases from the Server page. containr downloads the binary for its platform, verifies the checksum and that it runs, keeps the old binary as `containr.previous`, swaps in the new one and restarts in place. Containers keep running, but the dashboard, API and proxy are down for a few seconds. Installs that run from a cargo `target/` directory (like the source-built systemd unit in `systemd/`) update with `git pull` instead. `install.sh` updates from the command line.

Stable installs only see stable releases; prerelease installs also see prereleases. To follow a fork, set the repo in `containr.toml`:

```toml
[updates]
repo = "owner/repo"
```
