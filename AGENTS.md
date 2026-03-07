# containr agent guidelines

## project structure

rust monorepo with solidjs frontend.

- `crates/containr` - main binary
- `crates/containr-api` - axum api server
- `crates/containr-runtime` - docker container management
- `crates/containr-proxy` - pingora reverse proxy
- `crates/containr-common` - shared types and database
- `web/` - solidjs frontend
- `data/` - runtime storage (database, certs); don't commit
- `containr.toml` - main config file
- `containr.example.json` - app payload examples

## build commands

```bash
cargo build                      # debug build
cargo build --release            # release build
cargo run                        # run binary
cargo check                      # type check only

mise install                     # install node 24 and pnpm from mise.toml
cd web && pnpm install           # install deps
cd web && pnpm dev               # dev server port 3001
cd web && pnpm build             # production build
```

## test commands

```bash
cargo test                       # all tests
cargo test <name>                # tests matching name
cargo test --package containr-api   # specific crate
cargo test <name> -- --nocapture # single test with output
```

## lint and format

```bash
cargo fmt                        # format rust
cargo fmt -- --check             # check formatting
cargo clippy                     # lint rust
cd web && pnpm exec biome format --write . # format typescript
cd web && pnpm exec tsc --noEmit # type check frontend
```

## running locally

```bash
# terminal 1
cargo run

# terminal 2
cd web && pnpm dev
```

ports: api 3000, http 80, https 443, frontend dev 3001

## rust code style

imports (grouped with blank lines between):
```rust
use std::collections::HashMap;

use tokio::sync::mpsc;
use tracing::{error, info};

use crate::docker::DockerContainerManager;
use containr_common::models::App;
```

naming:
- structs/enums: PascalCase
- functions/variables: snake_case
- constants: SCREAMING_SNAKE_CASE

error handling:
- thiserror for library errors
- anyhow for application errors
- define Result<T> type alias per crate

documentation (essential only, all lowercase):
```rust
/// creates a new container with the given config
pub fn new(config: ContainerConfig) -> Self {
    // validate port range
    Self { config }
}
```

derives:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")] // for enums
```

## typescript code style

framework: solidjs (not react)
- createSignal for state
- createResource for data fetching
- Show/For for conditionals/lists
- A from @solidjs/router for links

components:
```typescript
/** fetches all apps from the api */
const Dashboard: Component = () => {
    const [apps] = createResource(fetchApps);
    return <div>...</div>;
};
export default Dashboard;
```

naming:
- components: PascalCase
- functions/variables: camelCase
- interfaces: PascalCase

documentation (tsdoc, essential only, all lowercase):
```typescript
/** handles user authentication */
{/* inline jsx comment */}
```

## styling - tailwind css

design: no rounded corners, dark theme, flowbite-inspired
- all border-radius: 0 (sharp edges)
- backgrounds: gray-900, gray-950
- accents: primary-500/600 (indigo)
- status: green (success), yellow (pending), red (error)

patterns:
- cards: `bg-gray-900 border border-gray-800 p-6`
- buttons: `px-4 py-2 bg-primary-600 hover:bg-primary-700`

## configuration

- use toml only (not json, not yaml)
- config file: containr.toml
- always install latest versions from crates.io and npm

key dependencies:
- rust: tokio, axum, serde, sled, thiserror, anyhow, tracing, pingora
- frontend: solid-js, @solidjs/router, tailwindcss, pnpm

## file conventions

- .txt over .md for documentation
- all content lowercase
- no emojis
- toml for configs

## common tasks

add api endpoint:
1. handler in `crates/containr-api/src/handlers/`
2. route in `crates/containr-api/src/server.rs`
3. types in `crates/containr-common/src/models.rs`

add frontend page:
1. component in `web/src/pages/`
2. route in `web/src/App.tsx`

## git conventions

- commit messages: lowercase, imperative mood
- example: "add user authentication endpoint"

## security

- do not commit secrets; set real values in containr.toml locally
- keep jwt_secret, github oauth secrets, and acme email out of version control
