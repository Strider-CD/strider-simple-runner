
test: lint
	@mocha -R spec

lint:
	jshint lib/* webapp.js

.PHONY: test lint

