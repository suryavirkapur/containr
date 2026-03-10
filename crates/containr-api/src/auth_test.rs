use uuid::Uuid;

use crate::auth::{
    create_api_key, create_exec_token, create_token, validate_exec_token,
    validate_token,
};

#[test]
fn create_api_key_round_trips_as_bearer_token() {
    let user_id = Uuid::new_v4();
    let secret = "test-secret";

    let token = match create_api_key(user_id, "admin@example.com", secret, 365)
    {
        Ok(token) => token,
        Err(error) => panic!("expected api key to be created: {}", error),
    };

    let claims = match validate_token(&token, secret) {
        Ok(claims) => claims,
        Err(error) => panic!("expected api key to validate: {}", error),
    };

    assert_eq!(claims.sub, user_id);
    assert_eq!(claims.email, "admin@example.com".to_string());
}

#[test]
fn create_token_round_trips_with_expected_user() {
    let user_id = Uuid::new_v4();
    let secret = "test-secret";

    let token = match create_token(user_id, "user@example.com", secret, 24) {
        Ok(token) => token,
        Err(error) => panic!("expected token to be created: {}", error),
    };

    let claims = match validate_token(&token, secret) {
        Ok(claims) => claims,
        Err(error) => panic!("expected token to validate: {}", error),
    };

    assert_eq!(claims.sub, user_id);
    assert_eq!(claims.email, "user@example.com".to_string());
}

#[test]
fn exec_token_round_trips_for_matching_container() {
    let user_id = Uuid::new_v4();
    let secret = "test-secret";

    let (token, _) =
        match create_exec_token(user_id, "containr-demo", secret, 60) {
            Ok(result) => result,
            Err(error) => {
                panic!("expected exec token to be created: {}", error)
            }
        };

    let claims = match validate_exec_token(&token, "containr-demo", secret) {
        Ok(claims) => claims,
        Err(error) => panic!("expected exec token to validate: {}", error),
    };

    assert_eq!(claims.sub, user_id);
    assert_eq!(claims.container_id, "containr-demo".to_string());
    assert_eq!(claims.kind, "container_exec".to_string());
}

#[test]
fn exec_token_rejects_different_container_id() {
    let user_id = Uuid::new_v4();
    let secret = "test-secret";

    let (token, _) =
        match create_exec_token(user_id, "containr-demo", secret, 60) {
            Ok(result) => result,
            Err(error) => {
                panic!("expected exec token to be created: {}", error)
            }
        };

    match validate_exec_token(&token, "containr-other", secret) {
        Ok(_) => panic!("expected mismatched container id to be rejected"),
        Err(error) => assert_eq!(
            error.to_string(),
            "unauthorized: exec token does not match container".to_string()
        ),
    }
}
