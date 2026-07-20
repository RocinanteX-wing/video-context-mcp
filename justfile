setup:
    npm install

dev:
    npx tsx src/index.ts

lint:
    npm run lint

typecheck:
    npm run typecheck

test:
    npm test

build:
    npm run build

ci: lint typecheck test build

# End-to-end smoke test against a real YouTube video (requires network + yt-dlp)
e2e:
    VCM_E2E=1 npx vitest run tests/e2e.test.ts
