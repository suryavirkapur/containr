create table if not exists metadata_http_request_logs (
    service_id text not null,
    idx integer not null,
    value text not null,
    created_at text not null default current_timestamp,
    primary key (service_id, idx)
);

create index if not exists metadata_http_request_logs_service_idx
    on metadata_http_request_logs (service_id, idx desc);
