-- record what queued each deployment: manual, api, mcp, webhook,
-- github or system. stored as a json string like status is
alter table deployments add column triggered_via text not null default '"manual"';
