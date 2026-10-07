-- files containr writes and mounts read-only into a service's containers
alter table services add column files text not null default '[]';
