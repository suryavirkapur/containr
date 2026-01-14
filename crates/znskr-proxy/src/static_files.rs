//! embedded static file loader
//!
//! serves the solid.js frontend from memory using rust-embed.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct Assets;

pub struct StaticFile {
    pub content_type: String,
    pub data: Vec<u8>,
}

/// loads an embedded static file or returns none if not found
pub fn load_static(path: &str) -> Option<StaticFile> {
    // normalize path: remove leading slash and default to index.html
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // try to get the file
    if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return Some(StaticFile {
            content_type: mime.as_ref().to_string(),
            data: content.data.into_owned(),
        });
    }

    // spa fallback: serve index.html for unknown paths
    if !path.contains('.') {
        if let Some(content) = Assets::get("index.html") {
            return Some(StaticFile {
                content_type: "text/html".to_string(),
                data: content.data.into_owned(),
            });
        }
    }

    None
}
