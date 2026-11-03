mock_provider "hcloud" {}

variables {
  ssh_key_ids      = ["fixture-key"]
  ssh_source_cidrs = ["192.0.2.10/32"]
  node_count       = 2
}

run "replicated_private_origins" {
  command = plan
  assert {
    condition     = length(hcloud_server.origin) == 2 && alltrue([for server in hcloud_server.origin : server.delete_protection && server.rebuild_protection && server.backups])
    error_message = "Origin nodes must retain backup and deletion protection."
  }
  assert {
    condition     = length(hcloud_firewall.origin.rule) == 1 && one(hcloud_firewall.origin.rule).port == "22"
    error_message = "Do not expose application or database ports publicly."
  }
}
run "reject_open_ssh" {
  command = plan
  variables { ssh_source_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.ssh_source_cidrs]
}
