//! exports openapi schema to stdout

use containr_api::openapi::ApiDoc;
use utoipa::OpenApi;

fn main() {
    let doc = ApiDoc::openapi();
    println!(
        "{}",
        doc.to_pretty_json()
            .expect("failed to serialize openapi schema")
    );
}
