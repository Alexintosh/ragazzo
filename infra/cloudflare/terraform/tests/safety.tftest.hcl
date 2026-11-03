mock_provider "cloudflare" {
  mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
    defaults = { id = "11111111-1111-4111-8111-111111111111" }
  }
}

variables {
  account_id = "11111111111111111111111111111111"
  zone_id    = "22222222222222222222222222222222"
  hostname   = "bots.example.com"
}

run "private_storage_and_tunnel" {
  command = plan
  assert {
    condition     = alltrue([for domain in cloudflare_r2_managed_domain.private : domain.enabled == false])
    error_message = "Data and backups must not have public r2.dev endpoints."
  }
  assert {
    condition     = cloudflare_r2_bucket.data.name != cloudflare_r2_bucket.backups.name
    error_message = "Backups need an isolated bucket."
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.app.config.ingress[1].service == "http_status:404"
    error_message = "Tunnel must reject unmatched hostnames."
  }
  assert {
    condition     = cloudflare_dns_record.app.proxied
    error_message = "Public traffic must enter Cloudflare."
  }
  assert {
    condition     = alltrue([for bucket in cloudflare_r2_bucket_lifecycle.multipart : bucket.rules[0].delete_objects_transition == null])
    error_message = "Live objects and snapshots must not be silently expired."
  }
}

run "reject_url_as_hostname" {
  command = plan
  variables { hostname = "https://bots.example.com/path" }
  expect_failures = [var.hostname]
}
