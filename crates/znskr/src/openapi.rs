//! exports openapi schema to stdout

use utoipa::OpenApi;
use znskr_api::openapi::ApiDoc;

fn main() {
    let doc = ApiDoc::openapi();
    println!(
        "{}",
        doc.to_pretty_json()
            .expect("failed to serialize openapi schema")
    );
}
