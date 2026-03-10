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
use containr_common::config::StorageConfig;
use containr_common::managed_services::StorageBucket;
use containr_runtime::StorageManager;

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
    pub endpoint: String,
    pub internal_endpoint: String,
    pub public_endpoint: Option<String>,
    pub internal_host: String,
    pub port: u16,
    pub publicly_exposed: bool,
    pub size_bytes: u64,
    pub managed_by_server: bool,
    pub created_at: String,
}

/// per-bucket s3 connection details
#[derive(Debug, Serialize, ToSchema)]
pub struct BucketConnectionResponse {
    pub bucket_name: String,
    pub endpoint: String,
    pub internal_endpoint: String,
    pub public_endpoint: Option<String>,
    pub internal_host: String,
    pub port: u16,
    pub access_key: String,
    pub secret_key: String,
    pub uses_shared_credentials: bool,
    pub note: String,
}

fn bucket_response(
    bucket: &StorageBucket,
    storage: &StorageConfig,
) -> BucketResponse {
    let internal_endpoint = storage.internal_endpoint();
    let public_endpoint = storage.public_endpoint();

    BucketResponse {
        id: bucket.id.to_string(),
        name: bucket.name.clone(),
        endpoint: public_endpoint
            .clone()
            .unwrap_or_else(|| internal_endpoint.clone()),
        internal_endpoint,
        public_endpoint: public_endpoint.clone(),
        internal_host: storage.rustfs_internal_host.clone(),
        port: storage.rustfs_port,
        publicly_exposed: public_endpoint.is_some(),
        size_bytes: bucket.size_bytes,
        managed_by_server: true,
        created_at: bucket.created_at.to_rfc3339(),
    }
}

fn bucket_connection_response(
    bucket: &StorageBucket,
    storage: &StorageConfig,
) -> BucketConnectionResponse {
    let internal_endpoint = storage.internal_endpoint();
    let public_endpoint = storage.public_endpoint();

    BucketConnectionResponse {
        bucket_name: bucket.name.clone(),
        endpoint: public_endpoint
            .clone()
            .unwrap_or_else(|| internal_endpoint.clone()),
        internal_endpoint,
        public_endpoint,
        internal_host: storage.rustfs_internal_host.clone(),
        port: storage.rustfs_port,
        access_key: storage.rustfs_access_key.clone(),
        secret_key: storage.rustfs_secret_key.clone(),
        uses_shared_credentials: true,
        note:
            "uses the shared containr rustfs credentials for s3 compatibility"
                .to_string(),
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
fn internal_error<E: std::fmt::Display>(
    e: E,
) -> (StatusCode, Json<ErrorResponse>) {
    tracing::error!("internal error: {}", e);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: "internal server error".to_string(),
        }),
    )
}

async fn storage_manager_from_parts(
    endpoint: &str,
    access_key: &str,
    secret_key: &str,
) -> Result<StorageManager, (StatusCode, Json<ErrorResponse>)> {
    if access_key.is_empty() || secret_key.is_empty() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "storage service credentials are not configured"
                    .to_string(),
            }),
        ));
    }

    StorageManager::new(endpoint, access_key, secret_key)
        .await
        .map_err(|e| {
            tracing::error!("failed to connect to rustfs: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("storage service unavailable: {}", e),
                }),
            )
        })
}

async fn maybe_refresh_bucket_sizes(
    state: &AppState,
    buckets: &mut [StorageBucket],
    storage: &StorageConfig,
) {
    if storage.rustfs_access_key.is_empty()
        || storage.rustfs_secret_key.is_empty()
    {
        return;
    }

    let storage_mgr = match StorageManager::new(
        storage.management_endpoint(),
        &storage.rustfs_access_key,
        &storage.rustfs_secret_key,
    )
    .await
    {
        Ok(manager) => manager,
        Err(error) => {
            tracing::warn!(error = %error, "failed to refresh bucket sizes");
            return;
        }
    };

    for bucket in buckets {
        match storage_mgr.get_bucket_size(&bucket.name).await {
            Ok(size_bytes) if size_bytes != bucket.size_bytes => {
                bucket.size_bytes = size_bytes;
                if let Err(error) = state.db.save_storage_bucket(bucket) {
                    tracing::warn!(
                        bucket = %bucket.name,
                        error = %error,
                        "failed to persist refreshed bucket size"
                    );
                }
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    bucket = %bucket.name,
                    error = %error,
                    "failed to refresh bucket size"
                );
            }
        }
    }
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

    let mut buckets = state
        .db
        .list_storage_buckets_by_owner(user_id)
        .map_err(internal_error)?;
    let storage = config.storage.clone();
    drop(config);

    maybe_refresh_bucket_sizes(&state, &mut buckets, &storage).await;

    let responses: Vec<BucketResponse> = buckets
        .iter()
        .map(|bucket| bucket_response(bucket, &storage))
        .collect();
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
) -> Result<(StatusCode, Json<BucketResponse>), (StatusCode, Json<ErrorResponse>)>
{
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
    let management_endpoint = config.storage.management_endpoint().to_string();
    let access_key = config.storage.rustfs_access_key.clone();
    let secret_key = config.storage.rustfs_secret_key.clone();
    let storage = config.storage.clone();
    drop(config);
    let storage_mgr = storage_manager_from_parts(
        &management_endpoint,
        &access_key,
        &secret_key,
    )
    .await?;

    let bucket = StorageBucket::new(
        user_id,
        req.name.clone(),
        storage.internal_endpoint(),
    );

    storage_mgr.create_bucket(&bucket).await.map_err(|e| {
        tracing::error!("failed to create bucket: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("failed to create bucket: {}", e),
            }),
        )
    })?;

    state
        .db
        .save_storage_bucket(&bucket)
        .map_err(internal_error)?;

    Ok((
        StatusCode::CREATED,
        Json(bucket_response(&bucket, &storage)),
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
    let mut bucket = state
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

    let storage = config.storage.clone();
    drop(config);
    maybe_refresh_bucket_sizes(
        &state,
        std::slice::from_mut(&mut bucket),
        &storage,
    )
    .await;

    Ok(Json(bucket_response(&bucket, &storage)))
}

/// get s3 connection details for a bucket
#[utoipa::path(
    get,
    path = "/api/buckets/{id}/connection",
    tag = "storage",
    params(("id" = Uuid, Path, description = "bucket id")),
    security(("bearer" = [])),
    responses(
        (status = 200, description = "bucket connection details", body = BucketConnectionResponse),
        (status = 401, description = "unauthorized", body = ErrorResponse),
        (status = 403, description = "forbidden", body = ErrorResponse),
        (status = 404, description = "not found", body = ErrorResponse)
    )
)]
pub async fn get_bucket_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<BucketConnectionResponse>, (StatusCode, Json<ErrorResponse>)> {
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

    if config.storage.rustfs_access_key.is_empty()
        || config.storage.rustfs_secret_key.is_empty()
    {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "storage service credentials are not configured"
                    .to_string(),
            }),
        ));
    }

    Ok(Json(bucket_connection_response(&bucket, &config.storage)))
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

    let management_endpoint = config.storage.management_endpoint().to_string();
    let access_key = config.storage.rustfs_access_key.clone();
    let secret_key = config.storage.rustfs_secret_key.clone();
    drop(config);
    let storage_mgr = storage_manager_from_parts(
        &management_endpoint,
        &access_key,
        &secret_key,
    )
    .await?;

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
