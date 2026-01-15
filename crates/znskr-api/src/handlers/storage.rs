//! storage buckets api handlers (s3-compatible via rustfs)

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::{extract_bearer_token, validate_token};
use crate::handlers::auth::ErrorResponse;
use crate::state::AppState;
use znskr_common::managed_services::StorageBucket;
use znskr_runtime::StorageManager;
use crate::security::{decrypt_value, encrypt_value};

/// bucket creation request
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateBucketRequest {
    /// bucket name
    pub name: String,
}

/// bucket response
#[derive(Debug, Serialize, ToSchema)]
pub struct BucketResponse {
    pub id: String,
    pub name: String,
    pub access_key: String,
    /// masked secret key
    pub secret_key: String,
    pub endpoint: String,
    pub size_bytes: u64,
    pub created_at: String,
}

impl From<&StorageBucket> for BucketResponse {
    fn from(b: &StorageBucket) -> Self {
        Self {
            id: b.id.to_string(),
            name: b.name.clone(),
            access_key: b.access_key.clone(),
            // mask secret key for security
            secret_key: format!("{}****", &b.secret_key[..8.min(b.secret_key.len())]),
            endpoint: b.endpoint.clone(),
            size_bytes: b.size_bytes,
            created_at: b.created_at.to_rfc3339(),
        }
    }
}

/// extracts user id from authorization header
fn get_user_id(
    headers: &HeaderMap,
    jwt_secret: &str,
) -> Result<Uuid, (StatusCode, Json<ErrorResponse>)> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "missing authorization header".to_string(),
                }),
            )
        })?;

    let token = extract_bearer_token(auth_header).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "invalid authorization header".to_string(),
            }),
        )
    })?;

    let claims = validate_token(token, jwt_secret).map_err(|e| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(claims.sub)
}

/// helper for internal errors
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}

/// list all buckets for the authenticated user
#[utoipa::path(
    get,
    path = "/api/buckets",
    tag = "storage",
    security(("bearer" = [])),
    responses(
        (status = 200, description = "list of buckets", body = Vec<BucketResponse>),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn list_buckets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<BucketResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let buckets = state
        .db
        .list_storage_buckets_by_owner(user_id)
        .map_err(internal_error)?;

    let responses: Vec<BucketResponse> = buckets.iter().map(BucketResponse::from).collect();
    Ok(Json(responses))
}

/// create a new storage bucket
#[utoipa::path(
    post,
    path = "/api/buckets",
    tag = "storage",
    security(("bearer" = [])),
    request_body = CreateBucketRequest,
    responses(
        (status = 201, description = "bucket created", body = BucketResponse),
        (status = 400, description = "invalid request", body = ErrorResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse)
    )
)]
pub async fn create_bucket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateBucketRequest>,
) -> Result<(StatusCode, Json<BucketResponse>), (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    // validate name (s3 bucket naming rules)
    if req.name.is_empty() || req.name.len() > 63 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "bucket name must be 1-63 characters".to_string(),
            }),
        ));
    }

    // get endpoint from config
    let endpoint = config.storage.rustfs_endpoint.clone();
    drop(config);

    let bucket = StorageBucket::new(user_id, req.name.clone(), endpoint.clone());

    // create bucket in rustfs via s3 api
    let storage_mgr = StorageManager::new(
        &endpoint,
        &bucket.access_key,
        &bucket.secret_key,
    )
    .await
    .map_err(|e| {
        tracing::error!("failed to connect to rustfs: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("storage service unavailable: {}", e),
            }),
        )
    })?;

    storage_mgr.create_bucket(&bucket).await.map_err(|e| {
        tracing::error!("failed to create bucket: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to create bucket: {}", e),
            }),
        )
    })?;

    // encrypt secret key before storing
    let encrypted_secret = encrypt_value(&*state.config.read().await, &bucket.secret_key).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("encryption failed: {}", e),
            }),
        )
    })?;

    // save bucket with encrypted secret
    let mut bucket_to_save = bucket.clone();
    bucket_to_save.secret_key = encrypted_secret;
    state.db.save_storage_bucket(&bucket_to_save).map_err(internal_error)?;

    // return with unmasked secret key for first-time display
    Ok((
        StatusCode::CREATED,
        Json(BucketResponse {
            id: bucket.id.to_string(),
            name: bucket.name.clone(),
            access_key: bucket.access_key.clone(),
            secret_key: bucket.secret_key.clone(), // unmasked on creation only
            endpoint: bucket.endpoint.clone(),
            size_bytes: 0,
            created_at: bucket.created_at.to_rfc3339(),
        }),
    ))
}

/// get a single bucket by id
#[utoipa::path(
    get,
    path = "/api/buckets/{id}",
    tag = "storage",
    params(("id" = Uuid, Path, description = "bucket id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "bucket details", body = BucketResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_bucket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<BucketResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let bucket = state
        .db
        .get_storage_bucket(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "bucket not found".to_string(),
                }),
            )
        })?;

    if bucket.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    Ok(Json(BucketResponse::from(&bucket)))
}

/// delete a storage bucket
#[utoipa::path(
    delete,
    path = "/api/buckets/{id}",
    tag = "storage",
    params(("id" = Uuid, Path, description = "bucket id")),
    security(("bearer" = [])),
    responses(
        (status = 204, description = "bucket deleted"),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn delete_bucket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let config = state.config.read().await;
    let user_id = get_user_id(&headers, &config.auth.jwt_secret)?;

    let bucket = state
        .db
        .get_storage_bucket(id)
        .map_err(internal_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "bucket not found".to_string(),
                }),
            )
        })?;

    if bucket.owner_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "access denied".to_string(),
            }),
        ));
    }

    // decrypt secret key for rustfs api
    let secret_key = decrypt_value(&config, &bucket.secret_key, Some(&config.auth.jwt_secret))
        .unwrap_or_else(|_| bucket.secret_key.clone());

    // delete bucket in rustfs via s3 api
    let storage_mgr = StorageManager::new(
        &config.storage.rustfs_endpoint,
        &bucket.access_key,
        &secret_key,
    )
    .await
    .map_err(|e| {
        tracing::error!("failed to connect to rustfs: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("storage service unavailable: {}", e),
            }),
        )
    })?;

    storage_mgr.delete_bucket(&bucket.name).await.map_err(|e| {
        tracing::error!("failed to delete bucket: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to delete bucket: {}", e),
            }),
        )
    })?;

    state.db.delete_storage_bucket(id).map_err(internal_error)?;

    Ok(StatusCode::NO_CONTENT)
}
