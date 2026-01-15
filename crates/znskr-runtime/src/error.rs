//! shared runtime error types

use thiserror::Error;

/// runtime errors
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("operation failed: {0}")]
    Operation(String),
}

/// result type for runtime operations
pub type Result<T> = std::result::Result<T, ClientError>;

