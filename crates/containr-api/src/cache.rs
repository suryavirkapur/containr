use std::path::Path;

use containr_common::{Error, Result};

#[derive(Clone)]
pub struct CacheStore {
    db: sled::Db,
    oauth_states: sled::Tree,
}

impl CacheStore {
    pub fn open(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path).map_err(|error| {
            Error::Internal(format!(
                "failed to create cache directory: {error}"
            ))
        })?;

        let db = sled::open(path).map_err(cache_error)?;
        let oauth_states = db.open_tree("oauth_states").map_err(cache_error)?;

        Ok(Self { db, oauth_states })
    }

    pub fn insert_oauth_state(
        &self,
        state: &str,
        expires_at: i64,
    ) -> Result<()> {
        self.oauth_states
            .insert(state.as_bytes(), expires_at.to_be_bytes().to_vec())
            .map_err(cache_error)?;
        self.db.flush().map_err(cache_error)?;
        Ok(())
    }

    pub fn take_oauth_state(&self, state: &str) -> Result<Option<i64>> {
        let value = self
            .oauth_states
            .remove(state.as_bytes())
            .map_err(cache_error)?;
        self.db.flush().map_err(cache_error)?;
        value.map(decode_i64).transpose()
    }

    pub fn cleanup_expired_oauth_states(&self, now: i64) -> Result<usize> {
        let mut expired = Vec::new();

        for entry in self.oauth_states.iter() {
            let (key, value) = entry.map_err(cache_error)?;
            if decode_i64(value)? < now {
                expired.push(key);
            }
        }

        for key in &expired {
            self.oauth_states.remove(key).map_err(cache_error)?;
        }

        if !expired.is_empty() {
            self.db.flush().map_err(cache_error)?;
        }

        Ok(expired.len())
    }
}

fn decode_i64(bytes: sled::InlineArray) -> Result<i64> {
    let value: [u8; 8] = bytes.as_ref().try_into().map_err(|_| {
        Error::Internal("cache entry had an invalid i64 payload".to_string())
    })?;
    Ok(i64::from_be_bytes(value))
}

fn cache_error(error: std::io::Error) -> Error {
    Error::Internal(format!("cache error: {error}"))
}
