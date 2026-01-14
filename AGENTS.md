# Repository Guidelines

## Project Structure & Module Organization
- `crates/` contains the Rust workspace modules: `znskr` (main binary), `znskr-api`, `znskr-proxy`, `znskr-runtime`, and shared code in `znskr-common`.
- `web/` hosts the SolidJS dashboard (Vite + Tailwind) and its static assets.
- `data/` is runtime storage (database, certificates); don’t commit real data.
- `znskr.toml` is the main config file; use `znskr.example.json` for app payload examples.

## Build, Test, and Development Commands
- `cargo build --release`: builds the Rust binaries for production.
- `sudo ./target/release/znskr`: runs the server on ports 80/443 (root required).
- `./target/release/znskr --http-port 8080 --https-port 8443 --api-port 3000`: runs with custom ports.
- `cd web && bun install`: installs frontend dependencies.
- `cd web && bun dev`: runs the dashboard locally.
- `cd web && bun build`: builds the frontend assets.

## Coding Style & Naming Conventions
- Rust: 4-space indentation, `snake_case` for functions/modules, `CamelCase` for types. Prefer small, focused modules in `crates/*/src`.
- Frontend: 4-space indentation, `PascalCase` for components, `camelCase` for props/utilities. Keep UI components in `web/src/components` and pages in `web/src/pages`.
- Format Rust with `cargo fmt` (no custom `rustfmt` config is present).

## Testing Guidelines
- Run Rust tests with `cargo test` at the workspace root.
- Tests currently live in module-level `#[cfg(test)]` blocks (e.g., `crates/znskr-common/src/encryption.rs`); follow that pattern for new unit tests.
- No dedicated frontend test runner is configured; call out manual UI verification in PRs when relevant.

## Commit & Pull Request Guidelines
- Commit messages follow Conventional Commits (e.g., `feat: ...`, `fix: ...`, `chore: ...`).
- PRs should include: a concise summary, testing notes (commands run), and screenshots/gifs for UI changes.
- Link related issues or describe the motivation if no issue exists.

## Security & Configuration Tips
- Do not commit secrets; set real values in `znskr.toml` locally.
- Keep `jwt_secret`, GitHub OAuth secrets, and ACME email out of version control.
