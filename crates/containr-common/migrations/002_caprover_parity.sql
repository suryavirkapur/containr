-- service settings added for caprover parity
alter table services add column notes text;
alter table services add column basic_auth text;
alter table services add column port_mappings text not null default '[]';

-- per-owner private container registries
create table if not exists registries (
    id text primary key,
    owner_id text not null,
    server text not null,
    username text not null,
    password_enc text not null,
    created_at text not null,
    foreign key (owner_id) references users(id) on delete cascade
);

create index if not exists registries_owner_idx on registries (owner_id);
