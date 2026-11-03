terraform {
  required_version = ">= 1.13.0, < 2.0.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.1"
    }
  }
}

# Optional origin provisioning; skip this root when using existing Docker hosts.
# HCLOUD_TOKEN is read from the environment. Cloud-init contains no application secrets.
provider "hcloud" {}

variable "name" {
  type    = string
  default = "rakazo-production"
}
variable "node_count" {
  type    = number
  default = 1
  validation {
    condition     = var.node_count >= 1 && var.node_count <= 20 && floor(var.node_count) == var.node_count
    error_message = "Choose 1–20 nodes. Size the Postgres connection limit before scaling."
  }
}
variable "server_type" {
  type    = string
  default = "cx33"
  validation {
    condition     = !startswith(var.server_type, "cax")
    error_message = "This image profile builds linux/amd64; choose an x86 server type."
  }
}
variable "location" {
  type    = string
  default = "fsn1"
}
variable "ssh_key_ids" {
  type = list(string)
  validation {
    condition     = length(var.ssh_key_ids) > 0
    error_message = "Provide existing Hetzner SSH key IDs or names."
  }
}
variable "ssh_source_cidrs" {
  type = list(string)
  validation {
    condition = length(var.ssh_source_cidrs) > 0 && alltrue([
      for cidr in var.ssh_source_cidrs : can(cidrhost(cidr, 0)) && !contains(["0.0.0.0/0", "::/0"], cidr)
    ])
    error_message = "Allow SSH only from your administrator/CI CIDRs, not the entire Internet."
  }
}

resource "hcloud_firewall" "origin" {
  name = var.name
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_source_cidrs
  }
  # HTTP ingress is through outbound cloudflared connectors, with no public origin ports.
}

resource "hcloud_placement_group" "origins" {
  name = var.name
  type = "spread"
}

resource "hcloud_server" "origin" {
  count              = var.node_count
  name               = "${var.name}-${count.index + 1}"
  server_type        = var.server_type
  location           = var.location
  image              = "ubuntu-24.04"
  ssh_keys           = var.ssh_key_ids
  firewall_ids       = [hcloud_firewall.origin.id]
  placement_group_id = hcloud_placement_group.origins.id
  backups            = true
  delete_protection  = true
  rebuild_protection = true
  user_data          = file("${path.module}/cloud-init.yaml")
  lifecycle { ignore_changes = [user_data, ssh_keys] }
}

output "hosts" {
  value = [for server in hcloud_server.origin : "root@${server.ipv4_address}"]
}
