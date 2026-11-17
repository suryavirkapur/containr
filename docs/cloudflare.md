# Cloudflare Tunnel

containr can serve domains through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) instead of exposing ports 80/443 publicly. Cloudflare terminates TLS at its edge and the tunnel carries traffic to the containr proxy over an outbound-only connection, so the VPS keeps no public web ports open for those domains.

This is opt-in per domain: a service can mix Cloudflare-fronted and directly reachable domains.

## Connecting

Go to **Settings → Cloudflare** and enter:

- an **API token** with `Cloudflare Tunnel: Edit` and `Zone → DNS: Edit` permissions (scoped to the zones you want to use),
- your **account ID** (visible on any domain's overview page in the Cloudflare dashboard).

containr verifies the token, creates a remotely-managed tunnel named `containr`, and stores both the API token and the tunnel token encrypted. Disconnecting deletes the tunnel and its DNS records, and turns every Cloudflare domain back into a direct route.

When connected, containr also:

- installs and supervises `cloudflared` (downloaded into `{data_dir}/bin` when it isn't on PATH),
- keeps the tunnel's ingress rules in sync with the configured domains,
- creates a proxied `CNAME` (`<tunnel-id>.cfargotunnel.com`) for each Cloudflare domain and removes stale ones,
- closes ports 80/443 on the host firewall once nothing else needs them (see below).

## Using it on a service

In a service's **Networking** tab, each custom domain gets a **Cloudflare** switch once the server is connected. Flipping it on moves that domain to the tunnel on save:

- no Let's Encrypt certificate is requested for the domain (TLS ends at the Cloudflare edge),
- the domain no longer needs to resolve to the server's IP — containr writes its DNS record itself, so the domain only has to live in a zone the token can see,
- direct requests to the domain on the host's public ports are refused; only the tunnel may reach the origin.

The equivalent API field is `cloudflare_domains` on the service settings (entries must also be in `domains`). Cloudflare domains can't be `http_only` — they always get HTTPS at the edge.

## Host firewall

Once every public ingress point is tunnel-fronted — meaning the dashboard's `base_domain` is empty, there are no external or storage routes, and no service still relies on a direct or default domain — containr installs an `inet containr` nftables table that drops inbound TCP on the proxy ports while allowing loopback (which `cloudflared` needs). The table only holds containr's own rules; Docker and other firewall tooling are left alone.

This requires `nft` on the host and containr running as root. If the rules can't be applied, the status page shows the ports as still open, and Cloudflare routes still refuse non-tunnel traffic at the proxy level.

The dashboard (`server.port`, default 2077) is never blocked — it isn't part of the proxy listener. If you want the dashboard behind the tunnel too, front it the same way through Cloudflare or restrict it with your own firewall.

## Status

The settings page shows the tunnel name, whether `cloudflared` is running, whether the firewall is active, each domain's DNS state, and the last sync error. `GET /api/cloudflare` returns the same state; `GET /api/cloudflare/zones` lists the zones the token can manage.

## Notes

- Client IPs come from `CF-Connecting-IP`, trusted only when the peer is the local `cloudflared`.
- One tunnel serves all Cloudflare domains on this server.
- Removing the Cloudflare flag or disconnecting immediately restores direct routing, so nothing goes dark.
