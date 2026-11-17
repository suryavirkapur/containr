-- custom domains routed through the cloudflare tunnel instead of being
-- served on the server's public http/https ports
alter table services add column cloudflare_domains text not null default '[]';

-- the single cloudflare account connection for the server. the api token
-- and tunnel token are stored encrypted like other secrets
create table if not exists cloudflare_settings (
    id integer primary key check (id = 1),
    api_token text not null,
    account_id text not null,
    tunnel_id text,
    tunnel_name text,
    tunnel_token text,
    created_at text not null,
    updated_at text not null
);
