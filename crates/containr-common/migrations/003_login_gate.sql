-- require a containr login before the proxy forwards to a service
alter table services add column login_gate text;
