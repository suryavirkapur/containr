//! error types for containr

use thiserror::Error;

/// result type alias for containr operations
pub type Result<T> = std::result::Result<T, Error>;

/// unified error type for containr
#[derive(Error, Debug)]
pub enum Error {
    #[error("database error: {0}")]
    Database(String),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("container error: {0}")]
    Container(String),

    #[error("proxy error: {0}")]
    Proxy(String),

    #[error("github error: {0}")]
    Github(String),

    #[error("acme error: {0}")]
    Acme(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl From<sled::Error> for Error {
    fn from(error: sled::Error) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}
