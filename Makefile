APP := share-web

.PHONY: fmt check test build release clean

fmt:
	cargo fmt

check:
	cargo check

test:
	cargo test

build:
	cargo build

release:
	cargo build --release

clean:
	cargo clean
