-- revocable personal access tokens for the rest api and the mcp endpoint.
-- only a sha-256 hash of the secret is stored.
create table if not exists api_tokens (
    id text primary key,
    user_id text not null,
    name text not null,
    token_hash text not null unique,
    prefix text not null,
    scope text not null default 'full',
    created_at text not null,
    last_used_at text,
    expires_at text,
    foreign key (user_id) references users(id) on delete cascade
);

create index if not exists api_tokens_user_idx on api_tokens (user_id);
