.PHONY: start build

# Existing database and computer image; no installation or data provisioning.
start:
	@exec node --import tsx apps/api/src/local-stack.ts --allow-host --with-docker

build:
	@pnpm native:build
