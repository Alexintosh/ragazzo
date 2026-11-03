resource "cloudflare_r2_bucket" "data" {
  account_id    = var.account_id
  name          = "${var.name}-data"
  location      = var.r2_location
  storage_class = "Standard"
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_r2_bucket" "backups" {
  account_id    = var.account_id
  name          = "${var.name}-backups"
  location      = var.r2_location
  storage_class = "Standard"
  lifecycle { prevent_destroy = true }
}

# Neither the computer homes/artifacts nor backups have a public serving endpoint.
resource "cloudflare_r2_managed_domain" "private" {
  for_each    = toset([cloudflare_r2_bucket.data.name, cloudflare_r2_bucket.backups.name])
  account_id  = var.account_id
  bucket_name = each.value
  enabled     = false
}

# Abort abandoned multipart uploads only. Do not expire live homes or backup snapshots.
resource "cloudflare_r2_bucket_lifecycle" "multipart" {
  for_each    = toset([cloudflare_r2_bucket.data.name, cloudflare_r2_bucket.backups.name])
  account_id  = var.account_id
  bucket_name = each.value
  rules = [{
    id         = "abort-incomplete-uploads"
    enabled    = true
    conditions = { prefix = "" }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
  }]
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "app" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.app.id
  config = {
    ingress = [
      { hostname = var.hostname, service = "http://web:5173" },
      { service = "http_status:404" }
    ]
  }
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.app.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
