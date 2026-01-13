//! embedded static file serving
//!
//! serves the solid.js frontend from memory using rust-embed.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{Response, StatusCode};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct Assets;

/// serves an embedded static file or returns none if not found
pub fn serve_static(path: &str) -> Option<Response<BoxBody<Bytes, hyper::Error>>> {
    // normalize path: remove leading slash and default to index.html
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // try to get the file
    if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        let body = Full::new(Bytes::from(content.data.into_owned()))
            .map_err(|never| match never {})
            .boxed();

        return Some(
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", mime.as_ref())
                .body(body)
                .unwrap(),
        );
    }

    // spa fallback: serve index.html for unknown paths
    if !path.contains('.') {
        if let Some(content) = Assets::get("index.html") {
            let body = Full::new(Bytes::from(content.data.into_owned()))
                .map_err(|never| match never {})
                .boxed();

            return Some(
                Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/html")
                    .body(body)
                    .unwrap(),
            );
        }
    }

    None
}
