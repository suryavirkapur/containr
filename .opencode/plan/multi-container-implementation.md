# Multi-Container Support Implementation for znskr PaaS

## Overview

You are tasked with implementing comprehensive multi-container support for the znskr PaaS platform. Currently, the platform supports only single-container deployments where each app deploys exactly one Docker container. Your goal is to transform this into a full-featured multi-container orchestration system while maintaining backward compatibility.

## Current Architecture Analysis

The znskr platform currently follows this flow:
- **App** → **Single Container** → **Single Port** → **Single Domain**
- Each app deploys exactly one Docker container
- Container exposes one port mapped to a domain
- Simple 1:1 relationship between app and container

## Your Implementation Tasks

### Phase 1: Core Data Model Updates

**File: `crates/znskr-common/src/models.rs`**

1. **Add new data structures:**
   - `ContainerService` - Represents individual container services within an app
   - `HealthCheck` - Health check configuration for services
   - `RestartPolicy` - Container restart policies
   - `ServiceDeployment` - Tracks deployment status per service

2. **Modify existing structures:**
   - Update `App` struct to include `services: Vec<ContainerService>` instead of single `port`
   - Update `Deployment` struct to include `service_deployments: Vec<ServiceDeployment>`
   - Remove single `port` field from `App` struct

3. **Key new fields to add:**
   ```rust
   pub struct ContainerService {
       pub id: Uuid,
       pub app_id: Uuid,
       pub name: String,           // e.g., "web", "api", "db"
       pub image: String,          // Docker image
       pub port: u16,              // Internal port
       pub env_vars: Vec<EnvVar>,
       pub memory_limit: Option<u64>,
       pub cpu_limit: Option<f64>,
       pub depends_on: Vec<Uuid>,  // Service dependencies
       pub health_check: Option<HealthCheck>,
       pub restart_policy: RestartPolicy,
   }
   ```

### Phase 2: Database Layer Updates

**File: `crates/znskr-common/src/db.rs`**

1. **Add new database methods:**
   - `save_service(&self, service: &ContainerService) -> Result<()>`
   - `get_service(&self, id: Uuid) -> Result<Option<ContainerService>>`
   - `list_services_by_app(&self, app_id: Uuid) -> Result<Vec<ContainerService>>`
   - `delete_service(&self, id: Uuid) -> Result<bool>`
   - `save_service_deployment(&self, deployment: &ServiceDeployment) -> Result<()>`
   - `get_service_deployment(&self, service_id: Uuid, deployment_id: Uuid) -> Result<Option<ServiceDeployment>>`
   - `list_service_deployments(&self, deployment_id: Uuid) -> Result<Vec<ServiceDeployment>>`

2. **Modify existing methods:**
   - Update `save_app` to handle services
   - Update `get_app` to load associated services
   - Ensure backward compatibility for single-container apps

### Phase 3: Container Runtime Enhancements

**File: `crates/znskr-runtime/src/docker.rs`**

1. **Extend DockerContainerManager:**
   - Add network management methods:
     - `create_network(&self, name: &str) -> Result<()>`
     - `remove_network(&self, name: &str) -> Result<()>`
     - `connect_to_network(&self, container_id: &str, network_name: &str) -> Result<()>`
   - Add multi-container deployment:
     - `deploy_service_group(&self, services: Vec<DockerContainerConfig>) -> Result<Vec<DockerContainerInfo>>`
     - `stop_service_group(&self, container_ids: Vec<String>) -> Result<()>`

2. **Update DockerContainerConfig:**
   - Add `network: Option<String>` field
   - Add `depends_on: Vec<String>` field
   - Add `health_check: Option<HealthCheckCommand>` field

3. **Implement health check support:**
   - Add health check command structure
   - Integrate with Docker's built-in health check functionality

### Phase 4: API Layer Updates

**File: `crates/znskr-api/src/handlers/apps.rs`**

1. **Update request/response structures:**
   - Modify `CreateAppRequest` to include `services: Vec<ServiceRequest>`
   - Add `ServiceRequest` struct with all service configuration fields
   - Add `HealthCheckRequest` struct
   - Update `AppResponse` to include `services: Vec<ServiceResponse>`
   - Add `ServiceResponse` struct with service status and health information

2. **Update handler functions:**
   - Modify `create_app` to handle multiple services
   - Update `get_app` to return service information
   - Update `update_app` to support service modifications
   - Add service-specific endpoints if needed

3. **Key new structures:**
   ```rust
   pub struct ServiceRequest {
       pub name: String,
       pub image: String,
       pub port: u16,
       pub env_vars: Option<Vec<EnvVarRequest>>,
       pub memory_limit: Option<u64>,
       pub cpu_limit: Option<f64>,
       pub depends_on: Option<Vec<String>>,
       pub health_check: Option<HealthCheckRequest>,
   }
   ```

### Phase 5: Deployment Pipeline Updates

**File: `crates/znskr-runtime/src/worker.rs`**

1. **Modify DeploymentWorker:**
   - Update `process_job` to handle multiple services
   - Implement dependency-aware deployment using topological sorting
   - Add Docker network creation per app
   - Implement service health monitoring

2. **Add new methods:**
   - `deploy_services_with_dependencies(&self, app: &App, network_name: &str) -> Result<Vec<ServiceDeployment>>`
   - `topological_sort_services(&self, services: &[ContainerService]) -> Result<Vec<ContainerService>>`
   - `wait_for_service_health(&self, service_name: &str) -> Result<()>`
   - `deploy_single_service(&self, service: &ContainerService, network_name: &str) -> Result<ServiceDeployment>`

3. **Implement service orchestration:**
   - Create Docker network for each app
   - Deploy services in dependency order
   - Wait for dependencies to be healthy before deploying dependents
   - Track per-service deployment status

### Phase 6: Frontend UI Updates

**File: `web/src/pages/NewApp.tsx`**

1. **Enhance app creation interface:**
   - Replace single service configuration with multi-service form
   - Add dynamic service addition/removal
   - Implement service dependency selection
   - Add health check configuration UI

2. **Key UI components to add:**
   - Service list with add/remove buttons
   - Service configuration forms (name, image, port, env vars)
   - Service dependency selection (dropdown of other services)
   - Health check configuration (path, interval, timeout, retries)
   - Resource limits configuration (memory, CPU)

3. **Update form handling:**
   - Modify `handleSubmit` to send services array
   - Add service validation logic
   - Implement dependency cycle detection

**File: `web/src/pages/AppDetail.tsx`**

1. **Update app detail view:**
   - Display all services instead of single container
   - Show per-service status and health
   - Add service-specific log viewing
   - Display service dependencies graph

2. **Add service management:**
   - Individual service start/stop/restart
   - Service scaling (future preparation)
   - Service health monitoring dashboard

### Phase 7: Configuration Updates

**File: `crates/znskr-common/src/config.rs`**

1. **Add container configuration:**
   ```rust
   pub struct ContainerConfig {
       pub default_memory_limit: u64,
       pub default_cpu_limit: f64,
       pub max_services_per_app: usize,
       pub health_check_interval: Duration,
       pub network_subnet: String,
   }
   ```

2. **Update main Config struct:**
   - Add `containers: ContainerConfig` field
   - Update default configuration

### Phase 8: Proxy and Routing Updates

**File: `crates/znskr-proxy/src/routes.rs`**

1. **Update Route struct:**
   - Add `service_name: Option<String>` field
   - Add `load_balancer: Option<LoadBalancerConfig>` field
   - Support multiple upstream servers per service

2. **Prepare for load balancing:**
   - Add load balancing strategies
   - Implement upstream server health checks
   - Add service discovery integration

## Implementation Guidelines

### Backward Compatibility
- Ensure existing single-container apps continue to work
- Automatically migrate existing apps to new service-based model
- Provide fallback for apps without explicit service configuration

### Dependency Management
- Implement topological sorting for service deployment order
- Add cycle detection in service dependencies
- Wait for dependent services to be healthy before deployment

### Network Management
- Create isolated Docker networks per app
- Use service names for internal DNS resolution
- Map only necessary ports to host

### Health Monitoring
- Implement configurable health checks per service
- Add automatic restart for unhealthy services
- Provide health status in API responses

### Error Handling
- Add comprehensive error messages for multi-container failures
- Implement partial deployment rollback on failures
- Provide detailed logging for debugging

## Testing Requirements

1. **Unit Tests:**
   - Test new data model serialization/deserialization
   - Test database operations for services
   - Test dependency sorting algorithms

2. **Integration Tests:**
   - Test multi-service deployment workflows
   - Test service dependency resolution
   - Test network creation and container communication

3. **End-to-End Tests:**
   - Test complete multi-service app deployment via API
   - Test frontend service configuration
   - Test service health monitoring and restart

## Success Criteria

1. **Functional Requirements:**
   - Deploy apps with multiple services
   - Service dependencies are respected during deployment
   - Services can communicate within app networks
   - Health checks work for individual services
   - Frontend supports multi-service configuration

2. **Non-Functional Requirements:**
   - Backward compatibility with existing apps
   - Performance doesn't degrade significantly
   - Error handling is comprehensive
   - Documentation is updated

3. **User Experience:**
   - Intuitive multi-service configuration UI
   - Clear service status and health information
   - Seamless migration from single to multi-container

## Files to Modify

### Core Files:
- `crates/znskr-common/src/models.rs`
- `crates/znskr-common/src/db.rs`
- `crates/znskr-common/src/config.rs`
- `crates/znskr-runtime/src/docker.rs`
- `crates/znskr-runtime/src/worker.rs`
- `crates/znskr-api/src/handlers/apps.rs`

### Frontend Files:
- `web/src/pages/NewApp.tsx`
- `web/src/pages/AppDetail.tsx`
- `web/src/components/` (potentially new components)

### Configuration Files:
- `znskr.toml` (update with new container config section)

## Priority Order

1. **Phase 1-2:** Data models and database layer (foundation)
2. **Phase 3:** Container runtime enhancements
3. **Phase 4:** API layer updates
4. **Phase 5:** Deployment pipeline updates
5. **Phase 6:** Frontend UI updates
6. **Phase 7-8:** Configuration and proxy updates

## Notes

- This is a significant architectural change - take time to understand the existing codebase before making changes
- Focus on maintaining backward compatibility throughout the implementation
- Test thoroughly at each phase to ensure stability
- Consider creating migration scripts for existing data
- Document all new APIs and data structures

You have full autonomy to implement these changes as you see fit, but should follow the outlined phases and priorities. Feel free to ask clarifying questions or suggest improvements to the implementation plan.