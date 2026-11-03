terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }
}

# Read CLOUDFLARE_API_TOKEN from the process environment; never put it in tfvars.
provider "cloudflare" {}
