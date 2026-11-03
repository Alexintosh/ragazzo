variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Set a Cloudflare account ID."
  }
}

variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "Set the zone ID that owns hostname."
  }
}

variable "hostname" {
  type        = string
  description = "Public application hostname in the selected Cloudflare zone."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$", var.hostname))
    error_message = "Use a lowercase hostname, without scheme, port or path."
  }
}

variable "name" {
  type    = string
  default = "rakazo-production"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,39}$", var.name))
    error_message = "Use 3–40 lowercase letters, digits or hyphens."
  }
}

variable "r2_location" {
  type        = string
  default     = "weur"
  description = "Placement hint, not a contractual data-residency guarantee."
  validation {
    condition     = contains(["weur", "eeur", "enam", "wnam", "apac", "oc"], var.r2_location)
    error_message = "Use a documented R2 location hint."
  }
}
