//! rustfs storage manager
//!
//! manages storage buckets via s3-compatible api for rustfs

use aws_sdk_s3::{
    config::{Credentials, Region},
    Client, Config,
};
use tracing::{info, error};

use crate::client::{ClientError, Result};
use znskr_common::managed_services::StorageBucket;

/// manages rustfs storage operations
pub struct StorageManager {
    client: Client,
    endpoint: String,
}

impl StorageManager {
    /// creates a new storage manager connected to rustfs
    pub async fn new(endpoint: &str, access_key: &str, secret_key: &str) -> Result<Self> {
        let creds = Credentials::new(access_key, secret_key, None, None, "znskr");

        let config = Config::builder()
            .endpoint_url(endpoint)
            .region(Region::new("us-east-1"))
            .credentials_provider(creds)
            .force_path_style(true)
            .build();

        let client = Client::from_conf(config);

        Ok(Self {
            client,
            endpoint: endpoint.to_string(),
        })
    }

    /// creates a new bucket
    pub async fn create_bucket(&self, bucket: &StorageBucket) -> Result<()> {
        info!("creating bucket: {}", bucket.name);

        self.client
            .create_bucket()
            .bucket(&bucket.name)
            .send()
            .await
            .map_err(|e| {
                error!("failed to create bucket: {}", e);
                ClientError::Operation(format!("failed to create bucket: {}", e))
            })?;

        info!("bucket created: {}", bucket.name);
        Ok(())
    }

    /// deletes a bucket
    pub async fn delete_bucket(&self, bucket_name: &str) -> Result<()> {
        info!("deleting bucket: {}", bucket_name);

        // first, list and delete all objects
        let objects = self.client
            .list_objects_v2()
            .bucket(bucket_name)
            .send()
            .await
            .map_err(|e| ClientError::Operation(format!("failed to list objects: {}", e)))?;

        if let Some(contents) = objects.contents {
            for obj in contents {
                if let Some(key) = obj.key {
                    self.client
                        .delete_object()
                        .bucket(bucket_name)
                        .key(&key)
                        .send()
                        .await
                        .map_err(|e| {
                            ClientError::Operation(format!("failed to delete object: {}", e))
                        })?;
                }
            }
        }

        // now delete the bucket
        self.client
            .delete_bucket()
            .bucket(bucket_name)
            .send()
            .await
            .map_err(|e| {
                error!("failed to delete bucket: {}", e);
                ClientError::Operation(format!("failed to delete bucket: {}", e))
            })?;

        info!("bucket deleted: {}", bucket_name);
        Ok(())
    }

    /// lists all buckets
    pub async fn list_buckets(&self) -> Result<Vec<String>> {
        let resp = self.client
            .list_buckets()
            .send()
            .await
            .map_err(|e| ClientError::Operation(format!("failed to list buckets: {}", e)))?;

        let names = resp
            .buckets
            .unwrap_or_default()
            .into_iter()
            .filter_map(|b| b.name)
            .collect();

        Ok(names)
    }

    /// checks if a bucket exists
    pub async fn bucket_exists(&self, bucket_name: &str) -> Result<bool> {
        match self.client.head_bucket().bucket(bucket_name).send().await {
            Ok(_) => Ok(true),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("404") || err_str.contains("NoSuchBucket") {
                    Ok(false)
                } else {
                    Err(ClientError::Operation(format!("failed to check bucket: {}", e)))
                }
            }
        }
    }

    /// gets bucket size in bytes (approximate)
    pub async fn get_bucket_size(&self, bucket_name: &str) -> Result<u64> {
        let objects = self.client
            .list_objects_v2()
            .bucket(bucket_name)
            .send()
            .await
            .map_err(|e| ClientError::Operation(format!("failed to list objects: {}", e)))?;

        let size = objects
            .contents
            .unwrap_or_default()
            .into_iter()
            .filter_map(|o| o.size)
            .sum::<i64>() as u64;

        Ok(size)
    }
}
