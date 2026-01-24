# znskr - Security & Architecture Improvements

## 📋 Overview

This document outlines critical security vulnerabilities, architectural issues, and improvement opportunities identified in the znskr codebase. znskr is a Rust-native Platform-as-a-Service (PaaS) for Docker containers with a Solid.js frontend.

## 🎯 Preventing Frontend-Backend Integration Issues

To ensure you don't miss renames when connecting frontend to backend, implement these strategies:

### Automated Type Generation
- **Tool**: Use `specta` or `ts-rs` to generate TypeScript types from Rust structs
- **Workflow**: Generate types during build process, commit to `web/src/types/generated.ts`
- **Validation**: Add CI check that generated types match actual API responses

### Contract Testing
- **Approach**: Test that API responses match expected TypeScript interfaces
- **Implementation**: Write tests that serialize/deserialize data and compare schemas
- **CI Integration**: Fail build if types don't align

### Naming Convention Enforcement
- **Backend**: Always use `#[serde(rename_all = "camelCase")]` on API structs
- **Frontend**: Use `camelCase` for all property names
- **Tooling**: Use IDE "Find All References" when renaming fields

### Change Detection Checklist
When renaming a field:
1. Update Rust struct field name
2. Update `#[serde(rename = "...")]` if custom name needed
3. Regenerate TypeScript types (`cargo build` or custom script)
4. Update frontend usage (IDE "Find All References" across workspace)
5. Run contract tests to verify compatibility
6. Update API documentation if needed

## 🚨 CRITICAL SECURITY ISSUES - IMMEDIATE ACTION REQUIRED

### 1. **Exposed Secrets in Version Control**
- **File**: `znskr.toml`
- **Issue**: JWT secret, encryption key, and GitHub webhook secret committed to git
- **Impact**: Full system compromise possible - attackers can forge tokens, decrypt data, forge webhooks
- **Fix**:
  - [ ] **IMMEDIATE**: Rotate ALL secrets immediately in production
  - [ ] Add `znskr.toml` to `.gitignore` (already done)
  - [ ] Remove `znskr.toml` from git history using:
    ```bash
    # Option 1: Using git filter-repo (recommended)
    git filter-repo --path znskr.toml --invert-paths

    # Option 2: Using BFG Repo-Cleaner
    bfg --delete-files znskr.toml

    # Option 3: Using git filter-branch (legacy)
    git filter-branch --force --index-filter \
      "git rm --cached --ignore-unmatch znskr.toml" \
      --prune-empty --tag-name-filter cat -- --all
    ```
  - [ ] Force push after cleaning: `git push origin --force --all`
  - [ ] Document secret generation process (e.g., `openssl rand -hex 32`)
  - [ ] Ensure all team members clone fresh repository after cleanup

### 2. **Overly Permissive CORS Configuration**
- **File**: `crates/znskr-api/src/server.rs:35-38`
- **Issue**: `allow_origin(Any).allow_methods(Any).allow_headers(Any)`
- **Impact**: CSRF attacks, data leakage from malicious sites
- **Fix**:
  - [ ] Restrict to specific origins (e.g., frontend domain + localhost):
    ```rust
    let allowed_origins = [
        "https://your-frontend-domain.com",
        "http://localhost:5173",  // Vite dev server
        "http://localhost:3000",  // Local development
    ];

    let cors = CorsLayer::new()
        .allow_origin(allowed_origins.map(|o| o.parse().unwrap()))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION])
        .allow_credentials(false);  // Set to true if using cookies
    ```
  - [ ] Consider reading allowed origins from configuration
  - [ ] Add CORS headers to error responses

### 3. **Missing Authentication on Some Endpoints**
- **Issue**: Frontend inconsistently includes Authorization headers
- **Files**: Compare `web/src/pages/Dashboard.tsx` (adds token) vs `web/src/pages/Databases.tsx` (missing)
- **Impact**: Potential unauthorized access
- **Fix**:
  - [ ] Implement centralized API client with automatic token injection
  - [ ] Add authentication middleware to ALL protected endpoints
  - [ ] Audit all API endpoints for missing auth checks

### 4. **No Rate Limiting**
- **Issue**: Authentication endpoints lack brute-force protection
- **Impact**: Credential stuffing attacks possible
- **Fix**:
  - [ ] Add rate limiting to `/api/auth/login` and `/api/auth/register`
  - [ ] Consider using `tower-governor` or custom rate limiting middleware
  - [ ] Implement exponential backoff for failed attempts

## ⚠️ MEDIUM SEVERITY ISSUES

### 5. **Command Injection Risk in Health Checks**
- **File**: `crates/znskr-runtime/src/docker.rs:206`
- **Issue**: `hc.cmd.join(" ")` without sanitization
- **Impact**: Potential Docker container escape if user controls health check commands
- **Fix**:
  - [ ] Sanitize health check commands
  - [ ] Consider using array format instead of string concatenation
  - [ ] Validate commands against allowlist

### 6. **Missing Input Validation**
- **Issue**: Domain names, email formats, URLs not validated
- **Impact**: Injection attacks, malformed data causing downstream issues
- **Fix**:
  - [ ] Add `validator` crate for input validation
  - [ ] Validate email formats, domain names, URLs in all handlers
  - [ ] Add maximum length checks for all string fields

### 7. **Insecure Default Configuration**
- **Issue**: Example config shows weak default JWT secret
- **Impact**: Users might not change defaults
- **Fix**:
  - [ ] Generate secure random secrets on first run if not configured
  - [ ] Warn users about default secrets in logs
  - [ ] Add configuration validation on startup

### 8. **File Upload Security**
- **Issue**: `/api/containers/{id}/files/upload` lacks security controls
- **Impact**: Malware upload, directory traversal, DoS via large files
- **Fix**:
  - [ ] Add file type validation (MIME type + extension)
  - [ ] Implement size limits (configurable per upload)
  - [ ] Sanitize file names to prevent directory traversal
  - [ ] Consider virus scanning for uploaded files

## 🔧 CLIENT-SERVER BOUNDARY IMPROVEMENTS

### 9. **Centralized API Client (Frontend)**
- **Issue**: Every component implements its own `fetch()` logic
- **Files**: All `.tsx` files with `fetch()` calls
- **Fix**:
  - [ ] Create `web/src/api/client.ts` with centralized request handling
  - [ ] Automatic token injection from localStorage
  - [ ] Consistent error handling (401 redirects, error parsing)
  - [ ] Request/response transformation

### 10. **Authentication Middleware (Backend)**
- **Issue**: Each handler validates tokens separately (duplicate code)
- **Files**: All handler files with `validate_token()` calls
- **Fix**:
  - [ ] Create `crates/znskr-api/src/middleware/auth.rs`
  - [ ] Extract token validation to reusable middleware
  - [ ] Add user claims to request extensions for easy access

### 11. **Shared Type Definitions**
- **Issue**: Frontend TypeScript interfaces may not match backend Rust structs
- **Impact**: Runtime errors, difficult refactoring
- **Fix**:
  - [ ] Use `specta` or `ts-rs` for automatic TypeScript type generation
  - [ ] Generate types during build process
  - [ ] Store generated types in `web/src/types/generated.ts`

### 12. **API Versioning**
- **Issue**: No version prefix in URLs
- **Impact**: Breaking changes affect all clients simultaneously
- **Fix**:
  - [ ] Add version prefix: `/api/v1/...`
  - [ ] Keep backward compatibility for reasonable time
  - [ ] Document versioning policy

## 🔤 NAMING CONSISTENCY & TYPE SAFETY

### 13. **Case Convention Mismatch**
- **Issue**: Backend uses `snake_case`, frontend expects `camelCase`
- **Current**: Manual `#[serde(rename_all = "camelCase")]` annotations
- **Fix**:
  - [ ] Ensure ALL API models have `#[serde(rename_all = "camelCase")]`
  - [ ] Add test to verify JSON field names match frontend expectations
  - [ ] Use IDE find/replace to standardize across codebase

### 14. **Contract Testing**
- **Issue**: No verification that frontend and backend types align
- **Fix**:
  - [ ] Add contract tests comparing generated TypeScript types with API responses
  - [ ] Test serialization/deserialization round-trip
  - [ ] Add CI check for type mismatches

### 15. **API Schema Validation**
- **Issue**: No formal schema validation at boundaries
- **Fix**:
  - [ ] Use `utoipa` for OpenAPI documentation
  - [ ] Generate OpenAPI spec and validate against it
  - [ ] Consider using `jsonschema` for runtime validation

## 🏗️ ARCHITECTURE IMPROVEMENTS

### 16. **Single Binary Monolith**
- **Issue**: API, proxy, worker in one process
- **Impact**: Single point of failure, difficult scaling
- **Fix**:
  - [ ] Split into separate binaries/crates
  - [ ] Use message queue (Redis/NATS) for inter-process communication
  - [ ] Design clear service boundaries

### 17. **Embedded Database (Sled) Limitations**
- **Issue**: Sled lacks migrations, backup complexity, limited scalability
- **Consider**:
  - [ ] Evaluate PostgreSQL for production use
  - [ ] If keeping Sled, implement migration system
  - [ ] Add backup/restore functionality

### 18. **Docker Socket Security**
- **Issue**: Requires Docker socket access (security risk)
- **Mitigation**:
  - [ ] Run znskr in Docker with socket mounted read-only if possible
  - [ ] Consider Docker API over TCP with TLS
  - [ ] Implement Docker resource limits

### 19. **Health Monitoring**
- **Issue**: Basic `/health` endpoint only
- **Fix**:
  - [ ] Add comprehensive health checks (database, Docker, disk space)
  - [ ] Implement metrics collection (Prometheus/OpenTelemetry)
  - [ ] Add alerting for critical failures

## 🧪 TESTING & QUALITY

### 20. **Security Testing**
- **Missing**: No security scanning in CI/CD
- **Add**:
  - [ ] `cargo-audit` for dependency vulnerabilities
  - [ ] `trivy` or `grype` for container scanning
  - [ ] SAST tools for code analysis

### 21. **Integration Tests**
- **Issue**: Limited test coverage
- **Add**:
  - [ ] API integration tests with authentication
  - [ ] Docker operation tests (using testcontainers)
  - [ ] End-to-end deployment tests

### 22. **Error Handling Improvement**
- **Issue**: Some internal errors exposed to clients
- **Fix**:
  - [ ] Use production error middleware
  - [ ] Hide stack traces in production
  - [ ] Consistent error response format

## 📝 DOCUMENTATION

### 23. **Security Documentation**
- **Missing**: No security best practices documentation
- **Add**:
  - [ ] SECURITY.md with reporting guidelines
  - [ ] Deployment security checklist
  - [ ] Secret management documentation

### 24. **API Documentation**
- **Current**: OpenAPI via `utoipa` but not published
- **Improve**:
  - [ ] Host API docs at `/api/docs`
  - [ ] Add example requests/responses
  - [ ] Document authentication flow

## 🗓️ PRIORITIZED IMPLEMENTATION PLAN

### Phase 1: Critical Security (Week 1)
1. Rotate exposed secrets and update `.gitignore`
2. Restrict CORS configuration
3. Add authentication middleware
4. Implement rate limiting

### Phase 2: Client-Server Boundary (Week 2)
1. Create centralized API client (frontend)
2. Set up automated type generation
3. Add API versioning (`/api/v1`)
4. Implement request/response validation

### Phase 3: Architecture & Testing (Week 3-4)
1. Split monolith into services
2. Add comprehensive testing
3. Implement monitoring/metrics
4. Improve error handling

### Phase 4: Production Readiness (Ongoing)
1. Database migration system
2. Backup/restore functionality
3. Security scanning in CI/CD
4. Documentation completion

## 🔍 SPECIFIC FILE CHANGES REQUIRED

### Backend (Rust)
- `crates/znskr-api/src/server.rs` - CORS configuration
- `crates/znskr-api/src/middleware/` - New auth middleware
- `crates/znskr-api/src/handlers/` - Add input validation
- `crates/znskr-runtime/src/docker.rs` - Health check sanitization
- `znskr.toml` - Secret rotation, add to `.gitignore`

### Frontend (TypeScript/Solid.js)
- `web/src/api/client.ts` - New centralized API client
- `web/src/types/generated.ts` - Auto-generated types
- All `.tsx` files - Replace `fetch()` with API client
- `web/src/context/AuthContext.tsx` - Integrate with API client

### Infrastructure
- `.github/workflows/` - Add security scanning
- `docker-compose.yml` - Service separation
- `scripts/` - Secret generation, backup scripts

## 🚦 SUCCESS METRICS

1. **Security**: No critical vulnerabilities in automated scans
2. **Reliability**: 99.9% API uptime, comprehensive health checks
3. **Developer Experience**: Type safety between frontend/backend, clear errors
4. **Maintainability**: Clear service boundaries, comprehensive tests
5. **Performance**: <100ms API response time, efficient resource usage

## 📞 RESPONSIBILITIES

- **Security fixes**: Entire team (priority 1)
- **Client-server boundary**: Frontend & backend developers
- **Architecture**: Senior engineers/architects
- **Testing**: QA engineers + developers
- **Documentation**: Technical writers + developers

## 📊 PROGRESS TRACKING

| Phase | Status | Completed Items | Target Date |
|-------|--------|-----------------|-------------|
| Phase 1: Critical Security | 🔴 Not Started | 0/4 | Week 1 |
| Phase 2: Client-Server Boundary | 🔴 Not Started | 0/4 | Week 2 |
| Phase 3: Architecture & Testing | 🔴 Not Started | 0/4 | Week 3-4 |
| Phase 4: Production Readiness | 🔴 Not Started | 0/4 | Ongoing |

### Completed Items
- [x] Added `znskr.toml` to `.gitignore`
- [x] Created comprehensive TODO.md

### Next Actions
1. Rotate exposed secrets and clean git history
2. Fix CORS configuration in `server.rs`
3. Create centralized API client in frontend

---

*Last Updated: 2026-01-22*
*Based on analysis of commit: 0d87827*
*Generated by Claude Code security review*