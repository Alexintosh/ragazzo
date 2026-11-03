# No secrets are exported. The deployment script fetches the tunnel token separately.
output "deployment" {
  value = {
    name          = var.name
    account_id    = var.account_id
    hostname      = var.hostname
    tunnel_id     = cloudflare_zero_trust_tunnel_cloudflared.app.id
    bucket        = cloudflare_r2_bucket.data.name
    backup_bucket = cloudflare_r2_bucket.backups.name
    endpoint      = "https://${var.account_id}.r2.cloudflarestorage.com"
  }
}
