//! build script for znskr-api
//!
//! runs vite build before compiling rust to embed frontend assets.
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

    // install dependencies
    let install_status = Command::new("bun")
        .arg("install")
        .current_dir(&web_dir)
        .status()
        .expect("failed to run bun install");

    if !install_status.success() {
        panic!("bun install failed");
    }

    // build frontend
    let build_status = Command::new("bun")
        .arg("run")
        .arg("build")
        .current_dir(&web_dir)
        .status()
        .expect("failed to run bun run build");

    if !build_status.success() {
        panic!("vite build failed");
    }
}
