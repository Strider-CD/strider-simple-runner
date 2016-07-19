
test: lint
	@./node_modules/.bin/mocha -R spec

lint:
	@./node_modules/.bin/eslint lib/*.js *.js

clean:
	rm -rf node_modules

install:
	npm install

reload: clean install

.PHONY: test lint clean install reload

