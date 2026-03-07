//! build script for containr-api
//!
//! runs pnpm vite build before compiling rust to embed frontend assets.
//! skipped when the `skip-web-build` feature is enabled.

use std::path::Path;
use std::process::Command;

fn main() {
    // skip web build if feature is enabled (used for openapi generation)
    if std::env::var("CARGO_FEATURE_SKIP_WEB_BUILD").is_ok() {
        return;
    }

    let web_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("web");

    // rerun if frontend source changes
    println!("cargo:rerun-if-changed={}/src", web_dir.display());
    println!("cargo:rerun-if-changed={}/index.html", web_dir.display());
    println!(
        "cargo:rerun-if-changed={}/vite.config.ts",
        web_dir.display()
    );
    println!("cargo:rerun-if-changed={}/package.json", web_dir.display());
    println!(
        "cargo:rerun-if-changed={}/pnpm-lock.yaml",
        web_dir.display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        web_dir.parent().unwrap().join("mise.toml").display()
    );

    // install dependencies
    let install_status = Command::new("mise")
        .arg("exec")
        .arg("--")
        .arg("pnpm")
        .arg("install")
        .arg("--frozen-lockfile")
        .current_dir(&web_dir)
        .status()
        .expect("failed to run mise exec pnpm install");

    if !install_status.success() {
        panic!("pnpm install failed");
    }

    // build frontend
    let build_status = Command::new("mise")
        .arg("exec")
        .arg("--")
        .arg("pnpm")
        .arg("run")
        .arg("build")
        .current_dir(&web_dir)
        .status()
        .expect("failed to run mise exec pnpm run build");

    if !build_status.success() {
        panic!("vite build failed");
    }
}
